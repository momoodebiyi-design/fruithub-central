-- Fix confirmed workflow actions that opened their review dialogs but failed
-- to persist or gave the operator no durable explanation.

-- A trigger function shared by unrelated tables must only reference fields
-- after branching on the table name. Referencing NEW.is_active while handling
-- user_invites (or cancellation fields while handling profiles) raises an
-- undefined-column error before the audited RPC can finish.
CREATE OR REPLACE FUNCTION public.guard_user_lifecycle_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'profiles' THEN
    IF NEW.is_active IS DISTINCT FROM OLD.is_active
       AND current_setting('fruithub.user_lifecycle_rpc', true) IS DISTINCT FROM 'allowed' THEN
      RAISE EXCEPTION 'User status must be changed through the user-management workflow';
    END IF;
  ELSIF TG_TABLE_NAME = 'user_invites' THEN
    IF (
      NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
      OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
      OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
    ) AND current_setting('fruithub.user_lifecycle_rpc', true) IS DISTINCT FROM 'allowed' THEN
      RAISE EXCEPTION 'Invitations must be cancelled through the user-management workflow';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported lifecycle table: %', TG_TABLE_NAME;
  END IF;

  RETURN NEW;
END;
$$;

-- Approvals must check the same location-aware ledger shown in the UI. The
-- previous function checked inventory_items.quantity and wrote a movement
-- without a location, which could make approval appear ineffective in the
-- location balance used by Central Stock.
CREATE OR REPLACE FUNCTION public.approve_stock_request(
  _request_id uuid,
  _notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.stock_requests%ROWTYPE;
  v_location_id uuid;
  v_current numeric;
  v_movement_id uuid;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorized to approve requests';
  END IF;

  SELECT *
  INTO v_req
  FROM public.stock_requests
  WHERE id = _request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Request is not pending';
  END IF;

  SELECT COALESCE(
    ii.default_location_id,
    (SELECT l.id FROM public.locations l WHERE l.is_default = true AND l.status = 'active' ORDER BY l.created_at LIMIT 1)
  )
  INTO v_location_id
  FROM public.inventory_items ii
  WHERE ii.id = v_req.item_id;

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'No active source location is configured for this item';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_req.item_id::text || ':' || v_location_id::text, 0)
  );

  SELECT COALESCE(on_hand, 0)
  INTO v_current
  FROM public.v_item_location_stock
  WHERE item_id = v_req.item_id
    AND location_id = v_location_id;

  v_current := COALESCE(v_current, 0);

  IF v_current < v_req.quantity THEN
    RAISE EXCEPTION 'Insufficient stock at the source location: have %, need %',
      v_current, v_req.quantity;
  END IF;

  INSERT INTO public.inventory_movements (
    item_id,
    type,
    quantity,
    reason,
    location_id,
    source,
    to_shop_id,
    performed_by
  )
  VALUES (
    v_req.item_id,
    'stock_out',
    v_req.quantity,
    'Stock request approved: ' || v_req.purpose,
    v_location_id,
    'stock_request',
    v_req.destination_shop_id,
    auth.uid()
  )
  RETURNING id INTO v_movement_id;

  UPDATE public.stock_requests
  SET status = 'fulfilled',
      reviewer_id = auth.uid(),
      review_notes = NULLIF(btrim(_notes), ''),
      reviewed_at = now(),
      fulfilled_movement_id = v_movement_id
  WHERE id = _request_id;

  INSERT INTO public.notifications (user_id, title, body, level, link)
  VALUES (
    v_req.requested_by,
    'Stock request approved',
    'Your request for ' || v_req.quantity::text || ' unit(s) was approved.',
    'info',
    '/requests'
  );

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(),
    'stock_request.approved',
    'stock_requests',
    _request_id::text,
    jsonb_build_object(
      'movement_id', v_movement_id,
      'location_id', v_location_id,
      'quantity', v_req.quantity
    )
  );

  RETURN v_movement_id;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_stock_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_stock_request(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
