-- Replenishment and Purchasing MVP realignment.
-- Keeps internal Shop 1 replenishment separate from supplier purchasing,
-- uses the location ledger for every decision, and preserves submitted records.

-- ---------------------------------------------------------------------------
-- Location policy and routed needs
-- ---------------------------------------------------------------------------

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS shop_id uuid REFERENCES public.shops(id) ON DELETE SET NULL;

UPDATE public.locations l
SET shop_id = s.id
FROM public.shops s
WHERE l.shop_id IS NULL
  AND lower(l.name) = lower(s.name);

CREATE UNIQUE INDEX IF NOT EXISTS locations_shop_unique
  ON public.locations(shop_id) WHERE shop_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.stock_level_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  critical_level numeric(14,3) NOT NULL,
  reorder_level numeric(14,3) NOT NULL,
  target_level numeric(14,3) NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('purchasing','production','replenishment')),
  source_location_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  configured_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  configured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_level_policy_thresholds_valid
    CHECK (target_level > reorder_level AND reorder_level >= critical_level AND critical_level >= 0),
  CONSTRAINT stock_level_policy_source_valid
    CHECK (
      (source_type = 'replenishment' AND source_location_id IS NOT NULL AND source_location_id <> location_id)
      OR (source_type <> 'replenishment' AND source_location_id IS NULL)
    ),
  UNIQUE(item_id, location_id)
);

CREATE SEQUENCE IF NOT EXISTS public.purchase_need_number_seq START 1;

CREATE TABLE IF NOT EXISTS public.purchase_needs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  need_number text NOT NULL UNIQUE DEFAULT ('NEED-' || to_char(current_date, 'YYYYMMDD') || '-' || lpad(nextval('public.purchase_need_number_seq')::text, 5, '0')),
  client_reference_id text UNIQUE,
  source text NOT NULL DEFAULT 'low_stock' CHECK (source IN ('low_stock','manual','replenishment','production')),
  source_type text NOT NULL CHECK (source_type IN ('purchasing','production','replenishment')),
  policy_id uuid REFERENCES public.stock_level_policies(id) ON DELETE SET NULL,
  item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  source_location_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  available_stock_snapshot numeric(14,3) NOT NULL DEFAULT 0,
  in_transit_snapshot numeric(14,3) NOT NULL DEFAULT 0,
  suggested_quantity numeric(14,3) NOT NULL CHECK (suggested_quantity >= 0),
  requested_quantity numeric(14,3) NOT NULL CHECK (requested_quantity > 0),
  required_date date,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','critical')),
  reason text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','sourcing','ordered','resolved','cancelled','archived')),
  is_automatic boolean NOT NULL DEFAULT false,
  stock_recovered_at timestamptz,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_notes text
);

CREATE UNIQUE INDEX IF NOT EXISTS purchase_needs_one_open_automatic
  ON public.purchase_needs(item_id, location_id, source_type)
  WHERE is_automatic AND status IN ('draft','ready','sourcing','ordered');
CREATE INDEX IF NOT EXISTS purchase_needs_queue_idx
  ON public.purchase_needs(source_type, status, priority, required_date);

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS notification_key text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_open_key_unique
  ON public.notifications(notification_key)
  WHERE notification_key IS NOT NULL AND resolved_at IS NULL;

GRANT SELECT ON public.stock_level_policies, public.purchase_needs TO authenticated;
GRANT ALL ON public.stock_level_policies, public.purchase_needs TO service_role;
ALTER TABLE public.stock_level_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_needs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_level_policies_read ON public.stock_level_policies;
CREATE POLICY stock_level_policies_read ON public.stock_level_policies
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS stock_level_policies_write ON public.stock_level_policies;
CREATE POLICY stock_level_policies_write ON public.stock_level_policies
  FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]));

DROP POLICY IF EXISTS purchase_needs_read ON public.purchase_needs;
CREATE POLICY purchase_needs_read ON public.purchase_needs
  FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.evaluate_stock_policy(_policy_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy public.stock_level_policies%ROWTYPE;
  v_available numeric := 0;
  v_in_transit numeric := 0;
  v_effective numeric := 0;
  v_suggested numeric := 0;
  v_need_id uuid;
  v_item_name text;
  v_location_name text;
  v_recipient record;
  v_link text;
  v_closing_balance numeric;
BEGIN
  SELECT p.*
  INTO v_policy
  FROM public.stock_level_policies p
  WHERE p.id = _policy_id;

  IF NOT FOUND OR NOT v_policy.is_active THEN
    RETURN NULL;
  END IF;

  SELECT i.name, l.name INTO v_item_name, v_location_name
  FROM public.inventory_items i
  CROSS JOIN public.locations l
  WHERE i.id = v_policy.item_id AND l.id = v_policy.location_id;

  SELECT COALESCE(s.on_hand, 0)
  INTO v_available
  FROM public.v_item_location_stock s
  WHERE s.item_id = v_policy.item_id AND s.location_id = v_policy.location_id;
  v_available := COALESCE(v_available, 0);

  IF v_policy.source_type = 'replenishment' THEN
    -- The last submitted closing is the approved operational snapshot for the
    -- next morning. Fall back to the location ledger only before a closing exists.
    SELECT scl.quantity_counted
    INTO v_closing_balance
    FROM public.shop_stock_counts sc
    JOIN public.shop_stock_count_lines scl ON scl.count_id = sc.id
    JOIN public.locations destination ON destination.shop_id = sc.shop_id
    WHERE destination.id = v_policy.location_id
      AND scl.item_id = v_policy.item_id
      AND sc.count_type = 'closing'
      AND sc.status = 'submitted'
    ORDER BY sc.count_date DESC, sc.submitted_at DESC NULLS LAST
    LIMIT 1;
    v_available := COALESCE(v_closing_balance, v_available, 0);

    SELECT COALESCE(sum(dl.quantity_dispatched), 0)
    INTO v_in_transit
    FROM public.dispatch_lines dl
    JOIN public.dispatches d ON d.id = dl.dispatch_id
    JOIN public.locations destination ON destination.shop_id = d.shop_id
    WHERE dl.item_id = v_policy.item_id
      AND destination.id = v_policy.location_id
      AND d.status = 'dispatched';
  END IF;

  v_effective := v_available + v_in_transit;
  v_suggested := greatest(0, v_policy.target_level - v_effective);
  v_link := CASE v_policy.source_type
    WHEN 'purchasing' THEN '/purchasing'
    WHEN 'production' THEN '/production'
    ELSE '/replenishment'
  END;

  IF v_effective <= v_policy.reorder_level AND v_suggested > 0 THEN
    INSERT INTO public.purchase_needs (
      source, source_type, policy_id, item_id, location_id, source_location_id,
      available_stock_snapshot, in_transit_snapshot, suggested_quantity,
      requested_quantity, priority, reason, is_automatic
    ) VALUES (
      CASE v_policy.source_type WHEN 'purchasing' THEN 'low_stock' ELSE v_policy.source_type END,
      v_policy.source_type, v_policy.id, v_policy.item_id, v_policy.location_id,
      v_policy.source_location_id, v_available, v_in_transit, v_suggested, v_suggested,
      CASE WHEN v_effective <= v_policy.critical_level THEN 'critical' ELSE 'normal' END,
      'Automatically created from the configured location stock policy', true
    )
    ON CONFLICT (item_id, location_id, source_type)
      WHERE is_automatic AND status IN ('draft','ready','sourcing','ordered')
    DO UPDATE SET
      policy_id = excluded.policy_id,
      available_stock_snapshot = excluded.available_stock_snapshot,
      in_transit_snapshot = excluded.in_transit_snapshot,
      suggested_quantity = excluded.suggested_quantity,
      requested_quantity = CASE
        WHEN public.purchase_needs.status = 'draft' THEN excluded.requested_quantity
        ELSE public.purchase_needs.requested_quantity
      END,
      priority = CASE
        WHEN excluded.priority = 'critical' THEN 'critical'
        ELSE public.purchase_needs.priority
      END,
      stock_recovered_at = NULL,
      updated_at = now()
    RETURNING id INTO v_need_id;

    IF v_effective <= v_policy.critical_level THEN
      FOR v_recipient IN
        SELECT DISTINCT ur.user_id
        FROM public.user_roles ur
        WHERE ur.role IN ('super_admin','management','operations_manager','inventory_officer')
      LOOP
        INSERT INTO public.notifications (
          user_id, title, body, level, link, notification_key
        ) VALUES (
          v_recipient.user_id,
          'Critical stock: ' || v_item_name,
          v_location_name || ' has ' || v_available::text || ' remaining; target is ' || v_policy.target_level::text || '.',
          'critical', v_link,
          'critical-policy:' || v_policy.id::text || ':' || v_recipient.user_id::text
        ) ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;
  ELSE
    UPDATE public.purchase_needs
    SET status = 'resolved', resolved_at = now(), stock_recovered_at = now(),
        resolution_notes = 'Stock recovered above reorder level before submission', updated_at = now()
    WHERE policy_id = v_policy.id AND is_automatic AND status = 'draft';

    UPDATE public.purchase_needs
    SET stock_recovered_at = COALESCE(stock_recovered_at, now()), updated_at = now()
    WHERE policy_id = v_policy.id AND is_automatic AND status IN ('ready','sourcing','ordered');

    UPDATE public.notifications
    SET resolved_at = now()
    WHERE notification_key LIKE 'critical-policy:' || v_policy.id::text || ':%'
      AND resolved_at IS NULL;
  END IF;

  RETURN v_need_id;
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_stock_policy(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.evaluate_stock_policy(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_stock_level_policy(
  _item_id uuid,
  _location_id uuid,
  _critical_level numeric,
  _reorder_level numeric,
  _target_level numeric,
  _source_type text,
  _source_location_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to configure stock policies';
  END IF;
  IF NOT (_target_level > _reorder_level AND _reorder_level >= _critical_level AND _critical_level >= 0) THEN
    RAISE EXCEPTION 'Thresholds must satisfy target > reorder >= critical >= 0';
  END IF;
  IF _source_type NOT IN ('purchasing','production','replenishment') THEN
    RAISE EXCEPTION 'Invalid sourcing route';
  END IF;
  IF (_source_type = 'replenishment') <> (_source_location_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Replenishment requires a source location; other routes do not';
  END IF;

  INSERT INTO public.stock_level_policies (
    item_id, location_id, critical_level, reorder_level, target_level,
    source_type, source_location_id, configured_by
  ) VALUES (
    _item_id, _location_id, _critical_level, _reorder_level, _target_level,
    _source_type, _source_location_id, auth.uid()
  ) ON CONFLICT (item_id, location_id) DO UPDATE SET
    critical_level = excluded.critical_level,
    reorder_level = excluded.reorder_level,
    target_level = excluded.target_level,
    source_type = excluded.source_type,
    source_location_id = excluded.source_location_id,
    is_active = true,
    configured_by = auth.uid(),
    configured_at = now(),
    updated_at = now()
  RETURNING id INTO v_id;

  INSERT INTO public.audit_log(user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'stock_policy.configured', 'stock_level_policies', v_id::text,
    jsonb_build_object('item_id',_item_id,'location_id',_location_id,'critical',_critical_level,'reorder',_reorder_level,'target',_target_level,'source_type',_source_type));

  PERFORM public.evaluate_stock_policy(v_id);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_stock_level_policy(uuid,uuid,numeric,numeric,numeric,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_stock_level_policy(uuid,uuid,numeric,numeric,numeric,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.evaluate_policies_after_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_policy record;
BEGIN
  FOR v_policy IN
    SELECT id FROM public.stock_level_policies
    WHERE item_id = NEW.item_id AND location_id = NEW.location_id AND is_active
  LOOP
    PERFORM public.evaluate_stock_policy(v_policy.id);
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_evaluate_policies_after_movement ON public.inventory_movements;
CREATE TRIGGER trg_evaluate_policies_after_movement
AFTER INSERT ON public.inventory_movements
FOR EACH ROW WHEN (NEW.location_id IS NOT NULL)
EXECUTE FUNCTION public.evaluate_policies_after_movement();

CREATE OR REPLACE FUNCTION public.evaluate_replenishment_after_closing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_policy record;
BEGIN
  IF NEW.count_type='closing' AND NEW.status='submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    FOR v_policy IN
      SELECT p.id
      FROM public.stock_level_policies p
      JOIN public.locations l ON l.id=p.location_id
      WHERE l.shop_id=NEW.shop_id AND p.source_type='replenishment' AND p.is_active
    LOOP
      PERFORM public.evaluate_stock_policy(v_policy.id);
    END LOOP;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_evaluate_replenishment_after_closing ON public.shop_stock_counts;
CREATE TRIGGER trg_evaluate_replenishment_after_closing
AFTER UPDATE OF status ON public.shop_stock_counts
FOR EACH ROW EXECUTE FUNCTION public.evaluate_replenishment_after_closing();

-- ---------------------------------------------------------------------------
-- Internal replenishment: approve -> issue/dispatch -> receive/discrepancy
-- ---------------------------------------------------------------------------

ALTER TABLE public.stock_requests
  ADD COLUMN IF NOT EXISTS client_reference_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS request_kind text NOT NULL DEFAULT 'midday' CHECK (request_kind IN ('morning','midday','manual')),
  ADD COLUMN IF NOT EXISTS source_location_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS destination_location_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approved_quantity numeric(14,3),
  ADD COLUMN IF NOT EXISTS adjustment_reason text,
  ADD COLUMN IF NOT EXISTS dispatch_id uuid REFERENCES public.dispatches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS replenishment_status text NOT NULL DEFAULT 'requested'
    CHECK (replenishment_status IN ('requested','approved','rejected','dispatched','received','discrepancy','cancelled','archived')),
  ADD COLUMN IF NOT EXISTS received_quantity numeric(14,3),
  ADD COLUMN IF NOT EXISTS receipt_notes text,
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archive_reason text;

ALTER TABLE public.stock_requests
  ADD COLUMN IF NOT EXISTS routed_need_id uuid REFERENCES public.purchase_needs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_requests_open_routed_need_unique
  ON public.stock_requests(routed_need_id)
  WHERE routed_need_id IS NOT NULL AND archived_at IS NULL;

ALTER TABLE public.dispatches
  ADD COLUMN IF NOT EXISTS replenishment_request_id uuid REFERENCES public.stock_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_location_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS destination_location_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS client_reference_id text UNIQUE;

CREATE TABLE IF NOT EXISTS public.replenishment_discrepancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.stock_requests(id) ON DELETE RESTRICT,
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  expected_quantity numeric(14,3) NOT NULL,
  received_quantity numeric(14,3) NOT NULL,
  difference numeric(14,3) GENERATED ALWAYS AS (received_quantity - expected_quantity) STORED,
  notes text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  reported_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolution_notes text
);
GRANT SELECT ON public.replenishment_discrepancies TO authenticated;
GRANT ALL ON public.replenishment_discrepancies TO service_role;
ALTER TABLE public.replenishment_discrepancies ENABLE ROW LEVEL SECURITY;
CREATE POLICY replenishment_discrepancies_read ON public.replenishment_discrepancies
  FOR SELECT TO authenticated USING (true);

-- Preserve and remove all pre-realignment test requests from operational queues.
INSERT INTO public.audit_log(user_id, action, entity, entity_id, previous_value, new_value)
SELECT NULL, 'stock_request.archived_for_realignment', 'stock_requests', sr.id::text,
  to_jsonb(sr), jsonb_build_object('reason','Archived during Replenishment/Purchasing MVP realignment')
FROM public.stock_requests sr
WHERE sr.archived_at IS NULL;

UPDATE public.stock_requests
SET archived_at = now(),
    archive_reason = 'Archived during Replenishment/Purchasing MVP realignment',
    replenishment_status = 'archived'
WHERE archived_at IS NULL;

DROP POLICY IF EXISTS "Managers can delete requests" ON public.stock_requests;
REVOKE UPDATE, DELETE ON public.stock_requests FROM authenticated;

CREATE OR REPLACE FUNCTION public.cancel_replenishment_request(_request_id uuid,_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_req public.stock_requests%ROWTYPE;
BEGIN
  IF COALESCE(btrim(_reason),'')='' THEN RAISE EXCEPTION 'Cancellation reason is required'; END IF;
  SELECT * INTO v_req FROM public.stock_requests WHERE id=_request_id FOR UPDATE;
  IF NOT FOUND OR v_req.archived_at IS NOT NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.replenishment_status NOT IN('requested','approved') THEN RAISE EXCEPTION 'A dispatched request cannot be cancelled'; END IF;
  IF v_req.requested_by<>auth.uid() AND NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN RAISE EXCEPTION 'Not authorized to cancel this request'; END IF;
  UPDATE public.stock_requests SET status='cancelled',replenishment_status='cancelled',review_notes=btrim(_reason),reviewer_id=auth.uid(),reviewed_at=now() WHERE id=_request_id;
  UPDATE public.purchase_needs SET status='draft',updated_at=now() WHERE id=v_req.routed_need_id AND status='sourcing';
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value) VALUES(auth.uid(),'replenishment.cancelled','stock_requests',_request_id::text,jsonb_build_object('reason',btrim(_reason)));
END; $$;

REVOKE ALL ON FUNCTION public.cancel_replenishment_request(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_replenishment_request(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.prepare_morning_replenishment(
  _need_id uuid, _client_reference_id text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_need public.purchase_needs%ROWTYPE; v_request_id uuid; v_shop_id uuid;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN RAISE EXCEPTION 'Only Inventory may prepare morning replenishment'; END IF;
  SELECT id INTO v_request_id FROM public.stock_requests WHERE client_reference_id=_client_reference_id;
  IF v_request_id IS NOT NULL THEN RETURN v_request_id; END IF;
  SELECT id INTO v_request_id FROM public.stock_requests WHERE routed_need_id=_need_id AND archived_at IS NULL;
  IF v_request_id IS NOT NULL THEN RETURN v_request_id; END IF;
  SELECT * INTO v_need FROM public.purchase_needs WHERE id=_need_id FOR UPDATE;
  IF NOT FOUND OR v_need.source_type<>'replenishment' OR v_need.status NOT IN('draft','ready') THEN RAISE EXCEPTION 'Morning suggestion is no longer available'; END IF;
  SELECT shop_id INTO v_shop_id FROM public.locations WHERE id=v_need.location_id;
  IF v_shop_id IS NULL OR v_need.source_location_id IS NULL THEN RAISE EXCEPTION 'Shop destination or Central source is not configured'; END IF;
  INSERT INTO public.stock_requests(requested_by,item_id,quantity,purpose,destination_shop_id,status,reviewer_id,review_notes,reviewed_at,
    client_reference_id,request_kind,source_location_id,destination_location_id,approved_quantity,replenishment_status,routed_need_id)
  VALUES(auth.uid(),v_need.item_id,v_need.requested_quantity,'Morning replenishment from configured Shop 1 target',v_shop_id,'approved',auth.uid(),
    'Policy-generated morning quantity reviewed by Inventory',now(),_client_reference_id,'morning',v_need.source_location_id,v_need.location_id,
    v_need.requested_quantity,'approved',v_need.id) RETURNING id INTO v_request_id;
  UPDATE public.purchase_needs SET status='sourcing',reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() WHERE id=v_need.id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value) VALUES(auth.uid(),'replenishment.morning_prepared','stock_requests',v_request_id::text,jsonb_build_object('need_id',v_need.id,'quantity',v_need.requested_quantity));
  RETURN v_request_id;
END; $$;

REVOKE ALL ON FUNCTION public.prepare_morning_replenishment(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_morning_replenishment(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_replenishment_request(
  _request_id uuid,
  _approved_quantity numeric,
  _notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.stock_requests%ROWTYPE;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to approve replenishment';
  END IF;
  SELECT * INTO v_req FROM public.stock_requests WHERE id = _request_id FOR UPDATE;
  IF NOT FOUND OR v_req.archived_at IS NOT NULL THEN RAISE EXCEPTION 'Replenishment request not found'; END IF;
  IF v_req.replenishment_status <> 'requested' THEN RAISE EXCEPTION 'Request is not awaiting review'; END IF;
  IF _approved_quantity <= 0 THEN RAISE EXCEPTION 'Approved quantity must be greater than zero'; END IF;
  IF _approved_quantity <> v_req.quantity AND COALESCE(btrim(_notes),'') = '' THEN
    RAISE EXCEPTION 'A reason is required when changing the requested quantity';
  END IF;
  UPDATE public.stock_requests SET
    status = 'approved', replenishment_status = 'approved', approved_quantity = _approved_quantity,
    adjustment_reason = CASE WHEN _approved_quantity <> quantity THEN btrim(_notes) END,
    review_notes = NULLIF(btrim(_notes),''), reviewer_id = auth.uid(), reviewed_at = now()
  WHERE id = _request_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'replenishment.approved','stock_requests',_request_id::text,
    jsonb_build_object('requested_quantity',v_req.quantity,'approved_quantity',_approved_quantity,'notes',_notes));
  RETURN _request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_replenishment_request(uuid,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_replenishment_request(uuid,numeric,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_stock_request(_request_id uuid, _notes text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_req public.stock_requests%ROWTYPE;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN RAISE EXCEPTION 'Not authorized to reject replenishment'; END IF;
  IF COALESCE(btrim(_notes),'')='' THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  SELECT * INTO v_req FROM public.stock_requests WHERE id=_request_id FOR UPDATE;
  IF NOT FOUND OR v_req.archived_at IS NOT NULL OR v_req.replenishment_status<>'requested' THEN RAISE EXCEPTION 'Request is not awaiting review'; END IF;
  UPDATE public.stock_requests SET status='rejected',replenishment_status='rejected',reviewer_id=auth.uid(),review_notes=btrim(_notes),reviewed_at=now() WHERE id=_request_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value) VALUES(auth.uid(),'replenishment.rejected','stock_requests',_request_id::text,jsonb_build_object('reason',btrim(_notes)));
END; $$;

REVOKE ALL ON FUNCTION public.reject_stock_request(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_stock_request(uuid,text) TO authenticated;

-- Compatibility wrapper: approval no longer deducts or fulfils stock.
CREATE OR REPLACE FUNCTION public.approve_stock_request(_request_id uuid, _notes text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_qty numeric;
BEGIN
  SELECT quantity INTO v_qty FROM public.stock_requests WHERE id = _request_id;
  RETURN public.approve_replenishment_request(_request_id, v_qty, _notes);
END;
$$;

CREATE OR REPLACE FUNCTION public.issue_replenishment_request(
  _request_id uuid,
  _client_reference_id text,
  _vehicle text DEFAULT NULL,
  _notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req public.stock_requests%ROWTYPE;
  v_dispatch_id uuid;
  v_current numeric := 0;
  v_reference text;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to issue replenishment';
  END IF;
  IF COALESCE(btrim(_client_reference_id),'') = '' THEN RAISE EXCEPTION 'Client reference is required'; END IF;

  SELECT id INTO v_dispatch_id FROM public.dispatches WHERE client_reference_id = _client_reference_id;
  IF v_dispatch_id IS NOT NULL THEN RETURN v_dispatch_id; END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = _request_id FOR UPDATE;
  IF NOT FOUND OR v_req.replenishment_status <> 'approved' THEN RAISE EXCEPTION 'Request is not approved for issue'; END IF;
  IF v_req.source_location_id IS NULL OR v_req.destination_shop_id IS NULL OR v_req.destination_location_id IS NULL THEN
    RAISE EXCEPTION 'Source and Shop 1 destination must be configured';
  END IF;
  SELECT COALESCE(on_hand,0) INTO v_current FROM public.v_item_location_stock
  WHERE item_id = v_req.item_id AND location_id = v_req.source_location_id;
  v_current := COALESCE(v_current,0);
  IF v_current < v_req.approved_quantity THEN
    RAISE EXCEPTION 'Insufficient source stock: have %, need %', v_current, v_req.approved_quantity;
  END IF;

  v_reference := 'REP-' || to_char(clock_timestamp(),'YYYYMMDD-HH24MISS') || '-' || substr(v_req.id::text,1,6);
  INSERT INTO public.dispatches(reference,shop_id,vehicle,notes,status,dispatched_by,
    replenishment_request_id,source_location_id,destination_location_id,client_reference_id)
  VALUES(v_reference,v_req.destination_shop_id,_vehicle,_notes,'dispatched',auth.uid(),
    v_req.id,v_req.source_location_id,v_req.destination_location_id,_client_reference_id)
  RETURNING id INTO v_dispatch_id;

  INSERT INTO public.dispatch_lines(dispatch_id,item_id,quantity_dispatched,notes)
  VALUES(v_dispatch_id,v_req.item_id,v_req.approved_quantity,'Replenishment ' || v_reference);
  INSERT INTO public.inventory_movements(item_id,type,quantity,reason,location_id,source,dispatch_id,to_shop_id,performed_by)
  VALUES(v_req.item_id,'stock_out',v_req.approved_quantity,'Replenishment dispatch ' || v_reference,
    v_req.source_location_id,'replenishment_dispatch',v_dispatch_id,v_req.destination_shop_id,auth.uid());

  UPDATE public.stock_requests SET status='fulfilled', replenishment_status='dispatched', dispatch_id=v_dispatch_id
  WHERE id=v_req.id;
  UPDATE public.purchase_needs SET status='ordered',updated_at=now() WHERE id=v_req.routed_need_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'replenishment.dispatched','stock_requests',v_req.id::text,
    jsonb_build_object('dispatch_id',v_dispatch_id,'quantity',v_req.approved_quantity));
  RETURN v_dispatch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_replenishment_request(uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_replenishment_request(uuid,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_replenishment_receipt(
  _request_id uuid,
  _client_reference_id text,
  _received_quantity numeric,
  _notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req public.stock_requests%ROWTYPE; v_movement_id uuid; v_discrepancy_id uuid;
BEGIN
  SELECT * INTO v_req FROM public.stock_requests WHERE id=_request_id FOR UPDATE;
  IF NOT FOUND OR v_req.replenishment_status <> 'dispatched' THEN RAISE EXCEPTION 'Request is not awaiting receipt'; END IF;
  IF NOT (
    public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','shop_supervisor']::public.app_role[])
    AND (NOT public.has_role(auth.uid(),'shop_supervisor') OR v_req.destination_shop_id = (SELECT shop_id FROM public.profiles WHERE id=auth.uid()))
  ) THEN RAISE EXCEPTION 'Not authorized to confirm this shop receipt'; END IF;
  IF _received_quantity < 0 OR _received_quantity > v_req.approved_quantity THEN RAISE EXCEPTION 'Invalid received quantity'; END IF;
  SELECT id INTO v_movement_id FROM public.inventory_movements WHERE source='replenishment_receipt:'||_client_reference_id LIMIT 1;
  IF v_movement_id IS NOT NULL THEN RETURN v_movement_id; END IF;
  IF _received_quantity > 0 THEN
    INSERT INTO public.inventory_movements(item_id,type,quantity,reason,location_id,source,dispatch_id,from_shop_id,performed_by)
    VALUES(v_req.item_id,'stock_in',_received_quantity,'Received replenishment dispatch',v_req.destination_location_id,
      'replenishment_receipt:'||_client_reference_id,v_req.dispatch_id,NULL,auth.uid()) RETURNING id INTO v_movement_id;
  END IF;
  UPDATE public.dispatches SET status='received',received_by=auth.uid(),received_at=now() WHERE id=v_req.dispatch_id;
  UPDATE public.stock_requests SET replenishment_status=CASE WHEN _received_quantity=v_req.approved_quantity THEN 'received' ELSE 'discrepancy' END,
    received_quantity=_received_quantity,receipt_notes=NULLIF(btrim(_notes),''),received_at=now() WHERE id=v_req.id;
  IF _received_quantity <> v_req.approved_quantity THEN
    IF COALESCE(btrim(_notes),'')='' THEN RAISE EXCEPTION 'Mismatch notes are required'; END IF;
    INSERT INTO public.replenishment_discrepancies(request_id,dispatch_id,item_id,expected_quantity,received_quantity,notes,reported_by)
    VALUES(v_req.id,v_req.dispatch_id,v_req.item_id,v_req.approved_quantity,_received_quantity,btrim(_notes),auth.uid()) RETURNING id INTO v_discrepancy_id;
  END IF;
  UPDATE public.purchase_needs SET status=CASE WHEN _received_quantity=v_req.approved_quantity THEN 'resolved' ELSE 'ordered' END,
    resolved_at=CASE WHEN _received_quantity=v_req.approved_quantity THEN now() ELSE resolved_at END,updated_at=now()
  WHERE id=v_req.routed_need_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'replenishment.received','stock_requests',v_req.id::text,
    jsonb_build_object('received_quantity',_received_quantity,'movement_id',v_movement_id,'discrepancy_id',v_discrepancy_id));
  RETURN v_movement_id;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_replenishment_receipt(uuid,text,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_replenishment_receipt(uuid,text,numeric,text) TO authenticated;

-- ---------------------------------------------------------------------------
-- One Purchasing workspace: needs, quoted orders, approval, delivery, receipt
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.purchasing_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  routine_approval_threshold_naira numeric(14,2),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.purchasing_settings(id,routine_approval_threshold_naira) VALUES(true,NULL) ON CONFLICT(id) DO NOTHING;

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS client_reference_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS workflow_status text NOT NULL DEFAULT 'draft'
    CHECK (workflow_status IN ('draft','awaiting_approval','approved','rejected','being_purchased','delivered','partially_received','received','cancelled')),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'NGN',
  ADD COLUMN IF NOT EXISTS quoted_total numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quotation_reference text,
  ADD COLUMN IF NOT EXISTS quotation_evidence_path text,
  ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS payment_reference text,
  ADD COLUMN IF NOT EXISTS payment_evidence_path text,
  ADD COLUMN IF NOT EXISTS payment_recorded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS purchase_need_id uuid REFERENCES public.purchase_needs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS quantity_quoted numeric(14,3),
  ADD COLUMN IF NOT EXISTS quantity_delivered numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_accepted numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_rejected numeric(14,3) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.purchase_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number text NOT NULL UNIQUE,
  client_reference_id text NOT NULL UNIQUE,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE RESTRICT,
  delivery_evidence_path text NOT NULL,
  delivery_notes text,
  recorded_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'awaiting_inspection' CHECK(status IN ('awaiting_inspection','inspected')),
  inspected_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  inspected_at timestamptz,
  quality_notes text
);

CREATE TABLE IF NOT EXISTS public.purchase_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_receipt_id uuid NOT NULL REFERENCES public.purchase_receipts(id) ON DELETE RESTRICT,
  purchase_order_item_id uuid NOT NULL REFERENCES public.purchase_order_items(id) ON DELETE RESTRICT,
  quantity_delivered numeric(14,3) NOT NULL CHECK(quantity_delivered >= 0),
  quantity_accepted numeric(14,3),
  quantity_rejected numeric(14,3),
  quality_notes text,
  inventory_movement_id uuid REFERENCES public.inventory_movements(id) ON DELETE SET NULL,
  UNIQUE(purchase_receipt_id,purchase_order_item_id)
);

CREATE TABLE IF NOT EXISTS public.purchase_discrepancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE RESTRICT,
  purchase_receipt_id uuid NOT NULL REFERENCES public.purchase_receipts(id) ON DELETE RESTRICT,
  purchase_order_item_id uuid NOT NULL REFERENCES public.purchase_order_items(id) ON DELETE RESTRICT,
  discrepancy_type text NOT NULL CHECK(discrepancy_type IN ('short','damaged','rejected','over_delivery')),
  quantity numeric(14,3) NOT NULL CHECK(quantity > 0),
  notes text NOT NULL,
  severity text NOT NULL DEFAULT 'normal' CHECK(severity IN ('normal','serious')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  reported_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolution_notes text
);

GRANT SELECT ON public.purchasing_settings, public.purchase_receipts, public.purchase_receipt_lines, public.purchase_discrepancies TO authenticated;
GRANT ALL ON public.purchasing_settings, public.purchase_receipts, public.purchase_receipt_lines, public.purchase_discrepancies TO service_role;
ALTER TABLE public.purchasing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_discrepancies ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchasing_settings_read ON public.purchasing_settings FOR SELECT TO authenticated USING(true);
CREATE POLICY purchase_receipts_read ON public.purchase_receipts FOR SELECT TO authenticated USING(true);
CREATE POLICY purchase_receipt_lines_read ON public.purchase_receipt_lines FOR SELECT TO authenticated USING(true);
CREATE POLICY purchase_discrepancies_read ON public.purchase_discrepancies FOR SELECT TO authenticated USING(true);

-- Submitted records are mutated only by audited RPCs and are never deleted.
DROP POLICY IF EXISTS po_write ON public.purchase_orders;
DROP POLICY IF EXISTS poi_write ON public.purchase_order_items;
REVOKE INSERT, UPDATE, DELETE ON public.purchase_orders, public.purchase_order_items FROM authenticated;

CREATE OR REPLACE FUNCTION public.mark_purchase_need_ready(
  _need_id uuid, _quantity numeric, _required_date date, _priority text, _reason text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_need public.purchase_needs%ROWTYPE;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Only Inventory may review purchase needs';
  END IF;
  SELECT * INTO v_need FROM public.purchase_needs WHERE id=_need_id FOR UPDATE;
  IF NOT FOUND OR v_need.source_type <> 'purchasing' OR v_need.status <> 'draft' THEN RAISE EXCEPTION 'Purchase need is not an editable draft'; END IF;
  IF _quantity<=0 OR _priority NOT IN ('normal','high','critical') OR COALESCE(btrim(_reason),'')='' THEN RAISE EXCEPTION 'Quantity, priority and reason are required'; END IF;
  UPDATE public.purchase_needs SET requested_quantity=_quantity,required_date=_required_date,priority=_priority,
    reason=btrim(_reason),status='ready',reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() WHERE id=_need_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'purchase_need.ready','purchase_needs',_need_id::text,jsonb_build_object('quantity',_quantity,'required_date',_required_date,'priority',_priority,'reason',_reason));
  RETURN _need_id;
END; $$;

CREATE OR REPLACE FUNCTION public.create_manual_purchase_need(
  _client_reference_id text,_item_id uuid,_location_id uuid,_quantity numeric,
  _required_date date,_priority text,_reason text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_available numeric:=0;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN RAISE EXCEPTION 'Only Inventory may create a manual purchase need'; END IF;
  SELECT id INTO v_id FROM public.purchase_needs WHERE client_reference_id=_client_reference_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  IF _quantity<=0 OR _priority NOT IN ('normal','high','critical') OR COALESCE(btrim(_reason),'')='' THEN RAISE EXCEPTION 'Quantity, priority and reason are required'; END IF;
  SELECT COALESCE(on_hand,0) INTO v_available FROM public.v_item_location_stock WHERE item_id=_item_id AND location_id=_location_id;
  INSERT INTO public.purchase_needs(client_reference_id,source,source_type,item_id,location_id,available_stock_snapshot,suggested_quantity,requested_quantity,required_date,priority,reason,status,is_automatic,reviewed_by,reviewed_at,created_by)
  VALUES(_client_reference_id,'manual','purchasing',_item_id,_location_id,COALESCE(v_available,0),_quantity,_quantity,_required_date,_priority,btrim(_reason),'ready',false,auth.uid(),now(),auth.uid()) RETURNING id INTO v_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value) VALUES(auth.uid(),'purchase_need.manual_created','purchase_needs',v_id::text,jsonb_build_object('item_id',_item_id,'location_id',_location_id,'quantity',_quantity,'reason',_reason));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.create_quoted_purchase_order(
  _client_reference_id text, _supplier_id uuid, _expected_date date,
  _quotation_reference text, _quotation_evidence_path text, _notes text, _lines jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_row jsonb; v_need public.purchase_needs%ROWTYPE; v_total numeric:=0; v_po_number text;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','procurement']::public.app_role[]) THEN RAISE EXCEPTION 'Not authorized to source purchases'; END IF;
  SELECT id INTO v_id FROM public.purchase_orders WHERE client_reference_id=_client_reference_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  IF _supplier_id IS NULL OR COALESCE(btrim(_quotation_reference),'')='' OR jsonb_array_length(_lines)=0 THEN RAISE EXCEPTION 'Supplier, quotation reference and at least one need are required'; END IF;
  v_po_number := 'PO-'||to_char(clock_timestamp(),'YYYYMMDD-HH24MISS');
  INSERT INTO public.purchase_orders(po_number,supplier_id,expected_date,status,workflow_status,notes,created_by,
    client_reference_id,quotation_reference,quotation_evidence_path)
  VALUES(v_po_number,_supplier_id,_expected_date,'draft','draft',_notes,auth.uid(),_client_reference_id,btrim(_quotation_reference),NULLIF(btrim(_quotation_evidence_path),'')) RETURNING id INTO v_id;
  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO v_need FROM public.purchase_needs WHERE id=(v_row->>'need_id')::uuid FOR UPDATE;
    IF NOT FOUND OR v_need.source_type<>'purchasing' OR v_need.status<>'ready' THEN RAISE EXCEPTION 'Need % is not ready',v_row->>'need_id'; END IF;
    IF (v_row->>'quantity')::numeric<=0 OR (v_row->>'unit_cost')::numeric<0 THEN RAISE EXCEPTION 'Quoted quantity and cost are invalid'; END IF;
    INSERT INTO public.purchase_order_items(purchase_order_id,item_id,purchase_need_id,location_id,quantity_ordered,quantity_quoted,unit_cost)
    VALUES(v_id,v_need.item_id,v_need.id,v_need.location_id,(v_row->>'quantity')::numeric,(v_row->>'quantity')::numeric,(v_row->>'unit_cost')::numeric);
    v_total:=v_total+((v_row->>'quantity')::numeric*(v_row->>'unit_cost')::numeric);
    UPDATE public.purchase_needs SET status='sourcing',updated_at=now() WHERE id=v_need.id;
  END LOOP;
  UPDATE public.purchase_orders SET quoted_total=v_total WHERE id=v_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'purchase_order.quoted','purchase_orders',v_id::text,jsonb_build_object('supplier_id',_supplier_id,'quoted_total',v_total,'lines',_lines));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.submit_quoted_purchase_order(_purchase_order_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_po public.purchase_orders%ROWTYPE; v_count int;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','procurement']::public.app_role[]) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=_purchase_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  SELECT count(*) INTO v_count FROM public.purchase_order_items WHERE purchase_order_id=_purchase_order_id;
  IF v_po.workflow_status<>'draft' THEN RAISE EXCEPTION 'Order is not a quoted draft'; END IF;
  IF v_po.supplier_id IS NULL OR v_count=0 OR v_po.quoted_total<=0 OR COALESCE(btrim(v_po.quotation_reference),'')='' THEN RAISE EXCEPTION 'Supplier, quote, quantities and costs are required'; END IF;
  UPDATE public.purchase_orders SET workflow_status='awaiting_approval',submitted_by=auth.uid(),submitted_at=now(),updated_at=now() WHERE id=_purchase_order_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value) VALUES(auth.uid(),'purchase_order.submitted','purchase_orders',_purchase_order_id::text,jsonb_build_object('total',v_po.quoted_total));
  RETURN _purchase_order_id;
END; $$;

CREATE OR REPLACE FUNCTION public.decide_purchase_order(_purchase_order_id uuid,_approve boolean,_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_po public.purchase_orders%ROWTYPE; v_threshold numeric;
BEGIN
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=_purchase_order_id FOR UPDATE;
  IF NOT FOUND OR v_po.workflow_status<>'awaiting_approval' THEN RAISE EXCEPTION 'Order is not awaiting approval'; END IF;
  IF v_po.submitted_by=auth.uid() OR public.has_role(auth.uid(),'procurement') THEN RAISE EXCEPTION 'Procurement cannot approve its own purchase'; END IF;
  SELECT routine_approval_threshold_naira INTO v_threshold FROM public.purchasing_settings WHERE id=true;
  IF v_threshold IS NULL THEN
    IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management']::public.app_role[]) THEN RAISE EXCEPTION 'MD approval is required until the monetary threshold is configured'; END IF;
  ELSIF v_po.quoted_total<=v_threshold THEN
    IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','production']::public.app_role[]) THEN RAISE EXCEPTION 'Production Manager or MD approval is required'; END IF;
  ELSIF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management']::public.app_role[]) THEN
    RAISE EXCEPTION 'MD approval is required for this order';
  END IF;
  IF NOT _approve AND COALESCE(btrim(_reason),'')='' THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  UPDATE public.purchase_orders SET workflow_status=CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,
    approved_by=auth.uid(),approved_at=now(),rejection_reason=CASE WHEN _approve THEN NULL ELSE btrim(_reason) END,updated_at=now()
  WHERE id=_purchase_order_id;
  UPDATE public.purchase_needs SET status=CASE WHEN _approve THEN 'ordered' ELSE 'ready' END,updated_at=now()
  WHERE id IN (SELECT purchase_need_id FROM public.purchase_order_items WHERE purchase_order_id=_purchase_order_id AND purchase_need_id IS NOT NULL);
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value) VALUES(auth.uid(),CASE WHEN _approve THEN 'purchase_order.approved' ELSE 'purchase_order.rejected' END,'purchase_orders',_purchase_order_id::text,jsonb_build_object('reason',_reason));
  RETURN _purchase_order_id;
END; $$;

CREATE OR REPLACE FUNCTION public.record_purchase_payment(
  _purchase_order_id uuid,_payment_reference text,_payment_evidence_path text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_po public.purchase_orders%ROWTYPE;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','procurement']::public.app_role[]) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=_purchase_order_id FOR UPDATE;
  IF NOT FOUND OR v_po.workflow_status<>'approved' THEN RAISE EXCEPTION 'Order must be approved before payment'; END IF;
  IF COALESCE(btrim(_payment_reference),'')='' OR COALESCE(btrim(_payment_evidence_path),'')='' THEN RAISE EXCEPTION 'Payment transfer reference and invoice/receipt evidence are required'; END IF;
  UPDATE public.purchase_orders SET payment_reference=btrim(_payment_reference),payment_evidence_path=btrim(_payment_evidence_path),
    payment_recorded_by=auth.uid(),payment_recorded_at=now(),workflow_status='being_purchased',status='ordered',updated_at=now() WHERE id=_purchase_order_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value) VALUES(auth.uid(),'purchase_order.payment_recorded','purchase_orders',_purchase_order_id::text,jsonb_build_object('payment_reference',_payment_reference,'evidence_path',_payment_evidence_path));
  RETURN _purchase_order_id;
END; $$;

CREATE OR REPLACE FUNCTION public.cancel_purchase_order(_purchase_order_id uuid,_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_po public.purchase_orders%ROWTYPE;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','procurement']::public.app_role[]) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF COALESCE(btrim(_reason),'')='' THEN RAISE EXCEPTION 'Cancellation reason is required'; END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=_purchase_order_id FOR UPDATE;
  IF NOT FOUND OR v_po.workflow_status IN('delivered','partially_received','received','cancelled') THEN RAISE EXCEPTION 'This order can no longer be cancelled'; END IF;
  UPDATE public.purchase_orders SET workflow_status='cancelled',status='cancelled',cancelled_at=now(),cancelled_by=auth.uid(),cancellation_reason=btrim(_reason),updated_at=now() WHERE id=_purchase_order_id;
  UPDATE public.purchase_needs SET status='ready',updated_at=now() WHERE id IN(SELECT purchase_need_id FROM public.purchase_order_items WHERE purchase_order_id=_purchase_order_id AND purchase_need_id IS NOT NULL) AND status IN('sourcing','ordered');
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value) VALUES(auth.uid(),'purchase_order.cancelled','purchase_orders',_purchase_order_id::text,jsonb_build_object('reason',btrim(_reason)));
  RETURN _purchase_order_id;
END; $$;

CREATE OR REPLACE FUNCTION public.record_purchase_delivery(
  _purchase_order_id uuid,_client_reference_id text,_delivery_evidence_path text,_notes text,_lines jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_po public.purchase_orders%ROWTYPE; v_receipt_id uuid; v_row jsonb; v_line public.purchase_order_items%ROWTYPE; v_number text;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','procurement']::public.app_role[]) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT id INTO v_receipt_id FROM public.purchase_receipts WHERE client_reference_id=_client_reference_id;
  IF v_receipt_id IS NOT NULL THEN RETURN v_receipt_id; END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=_purchase_order_id FOR UPDATE;
  IF NOT FOUND OR v_po.workflow_status NOT IN ('being_purchased','partially_received') THEN RAISE EXCEPTION 'Order is not ready for delivery'; END IF;
  IF COALESCE(btrim(_delivery_evidence_path),'')='' OR jsonb_array_length(_lines)=0 THEN RAISE EXCEPTION 'Delivery evidence and delivered quantities are required'; END IF;
  v_number:='REC-'||to_char(clock_timestamp(),'YYYYMMDD-HH24MISS');
  INSERT INTO public.purchase_receipts(receipt_number,client_reference_id,purchase_order_id,delivery_evidence_path,delivery_notes,recorded_by)
  VALUES(v_number,_client_reference_id,_purchase_order_id,btrim(_delivery_evidence_path),NULLIF(btrim(_notes),''),auth.uid()) RETURNING id INTO v_receipt_id;
  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO v_line FROM public.purchase_order_items WHERE id=(v_row->>'line_id')::uuid AND purchase_order_id=_purchase_order_id FOR UPDATE;
    IF NOT FOUND OR (v_row->>'delivered')::numeric<0 OR v_line.quantity_delivered+(v_row->>'delivered')::numeric>v_line.quantity_ordered THEN RAISE EXCEPTION 'Invalid delivered quantity'; END IF;
    INSERT INTO public.purchase_receipt_lines(purchase_receipt_id,purchase_order_item_id,quantity_delivered)
    VALUES(v_receipt_id,v_line.id,(v_row->>'delivered')::numeric);
    UPDATE public.purchase_order_items SET quantity_delivered=quantity_delivered+(v_row->>'delivered')::numeric WHERE id=v_line.id;
  END LOOP;
  UPDATE public.purchase_orders SET workflow_status='delivered',delivered_at=now(),updated_at=now() WHERE id=_purchase_order_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value) VALUES(auth.uid(),'purchase_order.delivery_recorded','purchase_orders',_purchase_order_id::text,jsonb_build_object('receipt_id',v_receipt_id,'lines',_lines));
  RETURN v_receipt_id;
END; $$;

CREATE OR REPLACE FUNCTION public.inspect_purchase_receipt(
  _purchase_receipt_id uuid,_client_reference_id text,_quality_notes text,_lines jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_receipt public.purchase_receipts%ROWTYPE; v_po public.purchase_orders%ROWTYPE; v_row jsonb; v_rl public.purchase_receipt_lines%ROWTYPE; v_ol public.purchase_order_items%ROWTYPE; v_accept numeric; v_reject numeric; v_short numeric; v_move uuid; v_all boolean; v_serious boolean; v_recipient record;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN RAISE EXCEPTION 'Only Inventory may receive purchases'; END IF;
  SELECT * INTO v_receipt FROM public.purchase_receipts WHERE id=_purchase_receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=v_receipt.purchase_order_id FOR UPDATE;
  IF v_receipt.status='inspected' THEN RETURN v_receipt.id; END IF;
  IF v_receipt.recorded_by=auth.uid() OR v_po.created_by=auth.uid() OR v_po.submitted_by=auth.uid() THEN RAISE EXCEPTION 'The purchaser cannot independently receive this order'; END IF;
  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO v_rl FROM public.purchase_receipt_lines WHERE id=(v_row->>'receipt_line_id')::uuid AND purchase_receipt_id=v_receipt.id FOR UPDATE;
    SELECT * INTO v_ol FROM public.purchase_order_items WHERE id=v_rl.purchase_order_item_id FOR UPDATE;
    v_accept:=COALESCE((v_row->>'accepted')::numeric,0); v_reject:=COALESCE((v_row->>'rejected')::numeric,0);
    IF v_accept<0 OR v_reject<0 OR v_accept+v_reject<>v_rl.quantity_delivered THEN RAISE EXCEPTION 'Accepted plus rejected must equal delivered'; END IF;
    IF v_accept>0 THEN
      INSERT INTO public.inventory_movements(item_id,type,quantity,reason,location_id,source,performed_by)
      VALUES(v_ol.item_id,'receipt',v_accept,'Accepted purchase receipt '||v_receipt.receipt_number,v_ol.location_id,
        'purchase_receipt:'||v_receipt.id::text||':'||v_rl.id::text,auth.uid()) RETURNING id INTO v_move;
    END IF;
    UPDATE public.purchase_receipt_lines SET quantity_accepted=v_accept,quantity_rejected=v_reject,quality_notes=v_row->>'notes',inventory_movement_id=v_move WHERE id=v_rl.id;
    UPDATE public.purchase_order_items SET quantity_accepted=quantity_accepted+v_accept,quantity_rejected=quantity_rejected+v_reject,quantity_received=quantity_received+v_accept WHERE id=v_ol.id;
    v_short:=greatest(0,v_ol.quantity_ordered-(v_ol.quantity_delivered+v_accept+v_reject-v_rl.quantity_delivered));
    IF v_reject>0 THEN
      INSERT INTO public.purchase_discrepancies(purchase_order_id,purchase_receipt_id,purchase_order_item_id,discrepancy_type,quantity,notes,severity,reported_by)
      VALUES(v_po.id,v_receipt.id,v_ol.id,'rejected',v_reject,COALESCE(NULLIF(v_row->>'notes',''),'Rejected during inspection'),CASE WHEN v_reject>=v_ol.quantity_ordered*0.2 THEN 'serious' ELSE 'normal' END,auth.uid());
    END IF;
  END LOOP;
  -- Record shortage against the order after this delivery (ordered - delivered).
  FOR v_ol IN SELECT * FROM public.purchase_order_items WHERE purchase_order_id=v_po.id LOOP
    v_short:=greatest(0,v_ol.quantity_ordered-v_ol.quantity_delivered);
    IF v_short>0 AND NOT EXISTS(SELECT 1 FROM public.purchase_discrepancies WHERE purchase_receipt_id=v_receipt.id AND purchase_order_item_id=v_ol.id AND discrepancy_type='short') THEN
      INSERT INTO public.purchase_discrepancies(purchase_order_id,purchase_receipt_id,purchase_order_item_id,discrepancy_type,quantity,notes,severity,reported_by)
      VALUES(v_po.id,v_receipt.id,v_ol.id,'short',v_short,'Delivered quantity is below the quoted order',CASE WHEN v_short>=v_ol.quantity_ordered*0.2 THEN 'serious' ELSE 'normal' END,auth.uid());
    END IF;
  END LOOP;
  SELECT EXISTS(SELECT 1 FROM public.purchase_discrepancies WHERE purchase_receipt_id=v_receipt.id AND severity='serious') INTO v_serious;
  IF v_serious THEN
    FOR v_recipient IN SELECT DISTINCT ur.user_id FROM public.user_roles ur WHERE ur.role IN('super_admin','management') LOOP
      INSERT INTO public.notifications(user_id,title,body,level,link,notification_key)
      VALUES(v_recipient.user_id,'Serious purchasing discrepancy',v_po.po_number||' has a serious shortage or rejection requiring review.','critical','/purchasing',
        'serious-purchase-discrepancy:'||v_receipt.id::text||':'||v_recipient.user_id::text) ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  UPDATE public.purchase_receipts SET status='inspected',inspected_by=auth.uid(),inspected_at=now(),quality_notes=NULLIF(btrim(_quality_notes),'') WHERE id=v_receipt.id;
  SELECT bool_and(quantity_accepted>=quantity_ordered) INTO v_all FROM public.purchase_order_items WHERE purchase_order_id=v_po.id;
  UPDATE public.purchase_orders SET workflow_status=CASE WHEN v_all THEN 'received' ELSE 'partially_received' END,
    status=CASE WHEN v_all THEN 'received'::public.purchase_order_status ELSE 'partial'::public.purchase_order_status END,updated_at=now() WHERE id=v_po.id;
  UPDATE public.purchase_needs SET status=CASE WHEN v_all THEN 'resolved' ELSE status END,resolved_at=CASE WHEN v_all THEN now() ELSE resolved_at END,updated_at=now()
  WHERE id IN(SELECT purchase_need_id FROM public.purchase_order_items WHERE purchase_order_id=v_po.id AND purchase_need_id IS NOT NULL);
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value) VALUES(auth.uid(),'purchase_receipt.inspected','purchase_receipts',v_receipt.id::text,jsonb_build_object('client_reference_id',_client_reference_id,'lines',_lines));
  RETURN v_receipt.id;
END; $$;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('mark_purchase_need_ready','create_manual_purchase_need','create_quoted_purchase_order','submit_quoted_purchase_order','decide_purchase_order','record_purchase_payment','cancel_purchase_order','record_purchase_delivery','inspect_purchase_receipt')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.signature);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.receive_purchase_order(uuid,jsonb);

INSERT INTO storage.buckets(id,name,public)
VALUES('purchase-evidence','purchase-evidence',false)
ON CONFLICT(id) DO NOTHING;

DROP POLICY IF EXISTS purchase_evidence_read ON storage.objects;
CREATE POLICY purchase_evidence_read ON storage.objects FOR SELECT TO authenticated
USING(bucket_id='purchase-evidence');
DROP POLICY IF EXISTS purchase_evidence_insert ON storage.objects;
CREATE POLICY purchase_evidence_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id='purchase-evidence' AND public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','procurement','inventory_officer']::public.app_role[]));

NOTIFY pgrst, 'reload schema';
