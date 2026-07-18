-- Harden invitation signup and serialize stock balance writes.
-- This migration is forward-only; it replaces functions without rewriting history.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite public.user_invites%ROWTYPE;
  v_role_count integer;
  v_invite_token text;
BEGIN
  -- Only one signup may decide whether it is the first account.
  PERFORM pg_advisory_xact_lock(hashtextextended('fruithub:user-bootstrap', 0));

  SELECT COUNT(*)
  INTO v_role_count
  FROM public.user_roles;

  IF v_role_count = 0 THEN
    INSERT INTO public.profiles (id, email, full_name)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email)
    );

    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'super_admin')
    ON CONFLICT DO NOTHING;

    RETURN NEW;
  END IF;

  v_invite_token := NULLIF(btrim(NEW.raw_user_meta_data->>'invite_token'), '');

  IF v_invite_token IS NULL THEN
    RAISE EXCEPTION 'Sign-up requires a valid invitation. Contact an administrator.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
  INTO v_invite
  FROM public.user_invites
  WHERE token = v_invite_token
    AND lower(email) = lower(NEW.email)
    AND accepted_at IS NULL
    AND expires_at > now()
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sign-up requires a valid invitation. Contact an administrator.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, department)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      v_invite.full_name,
      NEW.raw_user_meta_data->>'full_name',
      NEW.email
    ),
    v_invite.department
  );

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, v_invite.role)
  ON CONFLICT DO NOTHING;

  UPDATE public.user_invites
  SET accepted_at = now()
  WHERE id = v_invite.id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_manual_movement(
  _item_id uuid,
  _location_id uuid,
  _type movement_type,
  _quantity numeric,
  _reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current numeric;
  v_delta numeric;
  v_id uuid;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager','inventory_officer','production']::app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorized to record stock movements';
  END IF;

  IF _item_id IS NULL THEN
    RAISE EXCEPTION 'An inventory item is required';
  END IF;

  IF _location_id IS NULL THEN
    RAISE EXCEPTION 'A stock location is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.locations
    WHERE id = _location_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Unknown or inactive location';
  END IF;

  IF _type NOT IN (
    'stock_in','stock_out','adjustment','adjustment_in','adjustment_out',
    'damaged','expired','wastage','opening_balance','receipt'
  ) THEN
    RAISE EXCEPTION
      'Movement type % is not allowed for manual entry. Use the dedicated workflow.',
      _type;
  END IF;

  IF _type = 'adjustment' THEN
    v_delta := _quantity;
  ELSIF _type IN ('stock_in','opening_balance','receipt','adjustment_in') THEN
    IF _quantity <= 0 THEN
      RAISE EXCEPTION 'Quantity must be > 0';
    END IF;
    v_delta := abs(_quantity);
  ELSE
    IF _quantity <= 0 THEN
      RAISE EXCEPTION 'Quantity must be > 0';
    END IF;
    v_delta := -abs(_quantity);
  END IF;

  -- Balance checks and writes for one item/location are now atomic.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(_item_id::text || ':' || _location_id::text, 0)
  );

  IF v_delta < 0 THEN
    SELECT COALESCE(on_hand, 0)
    INTO v_current
    FROM public.v_item_location_stock
    WHERE item_id = _item_id
      AND location_id = _location_id;

    v_current := COALESCE(v_current, 0);

    IF v_current + v_delta < 0 THEN
      RAISE EXCEPTION
        'Insufficient stock at location: have %, requested %',
        v_current,
        abs(v_delta);
    END IF;
  END IF;

  INSERT INTO public.inventory_movements (
    item_id,
    type,
    quantity,
    reason,
    location_id,
    source,
    performed_by
  )
  VALUES (
    _item_id,
    _type,
    CASE WHEN _type = 'adjustment' THEN _quantity ELSE abs(_quantity) END,
    _reason,
    _location_id,
    'manual',
    auth.uid()
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_log (
    user_id,
    action,
    entity,
    entity_id,
    new_value
  )
  VALUES (
    auth.uid(),
    'movement.manual',
    'inventory_movements',
    v_id::text,
    jsonb_build_object(
      'item_id', _item_id,
      'location_id', _location_id,
      'type', _type,
      'quantity', _quantity,
      'reason', _reason
    )
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_manual_movement(
  uuid, uuid, movement_type, numeric, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_manual_movement(
  uuid, uuid, movement_type, numeric, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_location_stock_count(
  _item_id uuid,
  _location_id uuid,
  _physical_qty numeric,
  _reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_system numeric;
  v_delta numeric;
  v_id uuid;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorized to record stock counts';
  END IF;

  IF _item_id IS NULL THEN
    RAISE EXCEPTION 'An inventory item is required';
  END IF;

  IF _location_id IS NULL THEN
    RAISE EXCEPTION 'Location is required';
  END IF;

  IF _physical_qty < 0 THEN
    RAISE EXCEPTION 'Physical count must be >= 0';
  END IF;

  IF COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'Reason is required';
  END IF;

  -- Use the same item/location lock as manual movements.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(_item_id::text || ':' || _location_id::text, 0)
  );

  SELECT COALESCE(on_hand, 0)
  INTO v_system
  FROM public.v_item_location_stock
  WHERE item_id = _item_id
    AND location_id = _location_id;

  v_system := COALESCE(v_system, 0);
  v_delta := _physical_qty - v_system;

  IF v_delta = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.inventory_movements (
    item_id,
    type,
    quantity,
    reason,
    location_id,
    source,
    performed_by
  )
  VALUES (
    _item_id,
    'adjustment',
    v_delta,
    'Stock count: physical ' || _physical_qty ||
      ' vs system ' || v_system || ' — ' || _reason,
    _location_id,
    'stock_count',
    auth.uid()
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_log (
    user_id,
    action,
    entity,
    entity_id,
    new_value
  )
  VALUES (
    auth.uid(),
    'stock.count_adjustment',
    'inventory_movements',
    v_id::text,
    jsonb_build_object(
      'item_id', _item_id,
      'location_id', _location_id,
      'physical', _physical_qty,
      'system', v_system,
      'delta', v_delta,
      'reason', _reason
    )
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_location_stock_count(
  uuid, uuid, numeric, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_location_stock_count(
  uuid, uuid, numeric, text
) TO authenticated;
