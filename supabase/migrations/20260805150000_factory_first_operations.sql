-- Factory-first pilot: pause incomplete shop stock workflows, add controlled
-- Central stocktakes, simplify production consumption to packaging, and make
-- factory returns independently auditable.

-- ---------------------------------------------------------------------------
-- Operational feature controls and shop-workflow containment
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.operational_feature_flags (
  feature_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  reason text,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.operational_feature_flags TO authenticated;
GRANT ALL ON public.operational_feature_flags TO service_role;
ALTER TABLE public.operational_feature_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operational_feature_flags_read ON public.operational_feature_flags;
CREATE POLICY operational_feature_flags_read
  ON public.operational_feature_flags FOR SELECT TO authenticated USING (true);

INSERT INTO public.operational_feature_flags (feature_key, enabled, reason)
VALUES (
  'shop_stock_workflows',
  false,
  'Paused until point-of-sale transactions can maintain reliable shop balances'
)
ON CONFLICT (feature_key) DO UPDATE SET
  enabled = false,
  reason = excluded.reason,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.operational_feature_enabled(_feature_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT enabled FROM public.operational_feature_flags WHERE feature_key = _feature_key),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.operational_feature_enabled(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.operational_feature_enabled(text) TO authenticated;

DO $$
DECLARE
  v_policies integer := 0;
  v_needs integer := 0;
  v_requests integer := 0;
BEGIN
  UPDATE public.stock_level_policies
  SET is_active = false, updated_at = now()
  WHERE source_type = 'replenishment' AND is_active;
  GET DIAGNOSTICS v_policies = ROW_COUNT;

  UPDATE public.purchase_needs
  SET status = 'archived',
      resolution_notes = 'Archived while shop stock workflows are paused pending POS rollout',
      updated_at = now()
  WHERE source_type = 'replenishment'
    AND status IN ('draft', 'ready', 'sourcing');
  GET DIAGNOSTICS v_needs = ROW_COUNT;

  UPDATE public.stock_requests
  SET status = 'cancelled',
      replenishment_status = 'archived',
      archived_at = now(),
      archive_reason = 'Archived while shop stock workflows are paused pending POS rollout'
  WHERE archived_at IS NULL
    AND replenishment_status IN ('requested', 'approved');
  GET DIAGNOSTICS v_requests = ROW_COUNT;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    NULL,
    'system.shop_stock_workflows_paused',
    'operational_feature_flags',
    'shop_stock_workflows',
    jsonb_build_object(
      'policies_deactivated', v_policies,
      'needs_archived', v_needs,
      'requests_archived', v_requests,
      'history_preserved', true
    )
  );
END;
$$;

DROP TRIGGER IF EXISTS trg_evaluate_replenishment_after_closing ON public.shop_stock_counts;

REVOKE INSERT, UPDATE, DELETE ON public.shop_stock_counts FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.shop_stock_count_lines FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.stock_requests FROM authenticated;

REVOKE ALL ON FUNCTION public.submit_shop_stock_count(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.delete_shop_stock_count(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.cancel_replenishment_request(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.prepare_morning_replenishment(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.approve_replenishment_request(uuid, numeric, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.approve_stock_request(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.reject_stock_request(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.issue_replenishment_request(uuid, text, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.confirm_replenishment_receipt(uuid, text, numeric, text) FROM authenticated;

-- A factory dispatch remains a valid operational record while shop balances
-- are paused. Delivery confirmation records custody only and intentionally
-- does not create a shop stock balance.
CREATE OR REPLACE FUNCTION public.confirm_dispatch_receipt(
  _dispatch_id uuid,
  _client_reference_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dispatch public.dispatches%ROWTYPE;
  v_shop_stock_updated boolean := false;
BEGIN
  IF COALESCE(btrim(_client_reference_id), '') = '' THEN
    RAISE EXCEPTION 'Client reference is required';
  END IF;

  SELECT * INTO v_dispatch
  FROM public.dispatches
  WHERE id = _dispatch_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch not found'; END IF;
  IF v_dispatch.status IN ('received', 'reconciled') THEN RETURN v_dispatch.id; END IF;
  IF v_dispatch.status <> 'dispatched' THEN
    RAISE EXCEPTION 'Only a dispatched shipment can be confirmed delivered';
  END IF;

  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager','inventory_officer','sales']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorized to confirm this delivery';
  END IF;

  UPDATE public.dispatches
  SET status = 'received', received_by = auth.uid(), received_at = now()
  WHERE id = v_dispatch.id;

  IF v_dispatch.replenishment_request_id IS NOT NULL THEN
    UPDATE public.stock_requests
    SET replenishment_status = 'received',
        received_quantity = COALESCE(approved_quantity, quantity),
        received_at = now(),
        receipt_notes = 'Delivery closed after shop stock workflows were paused'
    WHERE id = v_dispatch.replenishment_request_id;

    UPDATE public.purchase_needs need
    SET status = 'resolved', resolved_at = now(), updated_at = now(),
        resolution_notes = 'Factory dispatch delivery confirmed; shop balance intentionally not maintained'
    FROM public.stock_requests request
    WHERE request.id = v_dispatch.replenishment_request_id
      AND need.id = request.routed_need_id;
  END IF;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(), 'dispatch.delivery_confirmed', 'dispatches', v_dispatch.id::text,
    jsonb_build_object(
      'client_reference_id', btrim(_client_reference_id),
      'shop_id', v_dispatch.shop_id,
      'client_id', v_dispatch.client_id,
      'shop_stock_updated', v_shop_stock_updated,
      'shop_stock_workflows_enabled', public.operational_feature_enabled('shop_stock_workflows')
    )
  );

  RETURN v_dispatch.id;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_dispatch_receipt(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_dispatch_receipt(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Central Stocktake
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.central_stocktake_number_seq START 1;

CREATE TABLE IF NOT EXISTS public.central_stocktakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_number text NOT NULL UNIQUE DEFAULT (
    'CST-' || to_char(current_date, 'YYYYMMDD') || '-' ||
    lpad(nextval('public.central_stocktake_number_seq')::text, 4, '0')
  ),
  client_reference_id text NOT NULL UNIQUE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('all','finished_good','raw_material','packaging','consumable')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  notes text,
  rejection_reason text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.central_stocktake_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id uuid NOT NULL REFERENCES public.central_stocktakes(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  expected_quantity numeric(14,3) NOT NULL,
  counted_quantity numeric(14,3),
  difference numeric(14,3) GENERATED ALWAYS AS (counted_quantity - expected_quantity) STORED,
  variance_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(stocktake_id, item_id)
);

CREATE INDEX IF NOT EXISTS central_stocktakes_created_at_idx
  ON public.central_stocktakes(created_at DESC);
CREATE INDEX IF NOT EXISTS central_stocktake_lines_stocktake_idx
  ON public.central_stocktake_lines(stocktake_id, item_id);

GRANT SELECT ON public.central_stocktakes, public.central_stocktake_lines TO authenticated;
GRANT ALL ON public.central_stocktakes, public.central_stocktake_lines TO service_role;
ALTER TABLE public.central_stocktakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_stocktake_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS central_stocktakes_read ON public.central_stocktakes;
CREATE POLICY central_stocktakes_read
  ON public.central_stocktakes FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS central_stocktake_lines_read ON public.central_stocktake_lines;
CREATE POLICY central_stocktake_lines_read
  ON public.central_stocktake_lines FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.create_central_stocktake(
  _scope text,
  _notes text,
  _client_reference_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stocktake_id uuid;
  v_location_id uuid;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','admin','management','operations_manager','inventory_officer']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Not authorized to start a Central stocktake'; END IF;
  IF _scope NOT IN ('all','finished_good','raw_material','packaging','consumable') THEN
    RAISE EXCEPTION 'Select a valid stocktake scope';
  END IF;
  IF COALESCE(btrim(_client_reference_id), '') = '' THEN
    RAISE EXCEPTION 'Client reference is required';
  END IF;

  SELECT id INTO v_stocktake_id
  FROM public.central_stocktakes
  WHERE client_reference_id = btrim(_client_reference_id);
  IF v_stocktake_id IS NOT NULL THEN RETURN v_stocktake_id; END IF;

  SELECT id INTO v_location_id
  FROM public.locations
  WHERE status = 'active' AND (is_default OR lower(name) = 'main store')
  ORDER BY is_default DESC, created_at
  LIMIT 1;
  IF v_location_id IS NULL THEN RAISE EXCEPTION 'Main Store is not configured'; END IF;

  INSERT INTO public.central_stocktakes (
    client_reference_id, location_id, scope, notes, created_by
  )
  VALUES (
    btrim(_client_reference_id), v_location_id, _scope,
    NULLIF(btrim(_notes), ''), auth.uid()
  )
  RETURNING id INTO v_stocktake_id;

  INSERT INTO public.central_stocktake_lines (
    stocktake_id, item_id, expected_quantity
  )
  SELECT
    v_stocktake_id,
    item.id,
    COALESCE(stock.on_hand, 0)
  FROM public.inventory_items item
  LEFT JOIN public.v_item_location_stock stock
    ON stock.item_id = item.id AND stock.location_id = v_location_id
  WHERE item.status = 'active'
    AND (_scope = 'all' OR item.category::text = _scope)
  ORDER BY item.name;

  IF NOT EXISTS (
    SELECT 1 FROM public.central_stocktake_lines WHERE stocktake_id = v_stocktake_id
  ) THEN RAISE EXCEPTION 'No active items match this stocktake scope'; END IF;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(), 'central_stocktake.created', 'central_stocktakes', v_stocktake_id::text,
    jsonb_build_object('scope', _scope, 'location_id', v_location_id)
  );

  RETURN v_stocktake_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_central_stocktake_lines(
  _stocktake_id uuid,
  _lines jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stocktake public.central_stocktakes%ROWTYPE;
  v_row jsonb;
  v_line_id uuid;
  v_counted numeric;
  v_expected numeric;
  v_reason text;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','admin','management','operations_manager','inventory_officer']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Not authorized to update a Central stocktake'; END IF;

  SELECT * INTO v_stocktake FROM public.central_stocktakes
  WHERE id = _stocktake_id FOR UPDATE;
  IF NOT FOUND OR v_stocktake.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft stocktake can be edited';
  END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'Stocktake lines must be provided as a list';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_line_id := (v_row ->> 'line_id')::uuid;
    v_counted := (v_row ->> 'counted_quantity')::numeric;
    v_reason := NULLIF(btrim(v_row ->> 'variance_reason'), '');
    IF v_counted IS NULL OR v_counted < 0 THEN
      RAISE EXCEPTION 'Counted quantities must be zero or greater';
    END IF;

    SELECT expected_quantity INTO v_expected
    FROM public.central_stocktake_lines
    WHERE id = v_line_id AND stocktake_id = _stocktake_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake line % was not found', v_line_id; END IF;
    IF v_counted <> v_expected AND v_reason IS NULL THEN
      RAISE EXCEPTION 'Explain every stock variance before saving';
    END IF;

    UPDATE public.central_stocktake_lines
    SET counted_quantity = v_counted,
        variance_reason = v_reason,
        updated_at = now()
    WHERE id = v_line_id;
  END LOOP;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(), 'central_stocktake.saved', 'central_stocktakes', _stocktake_id::text,
    jsonb_build_object('lines_updated', jsonb_array_length(_lines))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_central_stocktake(_stocktake_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_stocktake public.central_stocktakes%ROWTYPE;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','admin','management','operations_manager','inventory_officer']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Not authorized to submit a Central stocktake'; END IF;

  SELECT * INTO v_stocktake FROM public.central_stocktakes
  WHERE id = _stocktake_id FOR UPDATE;
  IF NOT FOUND OR v_stocktake.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft stocktake can be submitted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.central_stocktake_lines
    WHERE stocktake_id = _stocktake_id AND counted_quantity IS NULL
  ) THEN RAISE EXCEPTION 'Count every item before submitting the stocktake'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.central_stocktake_lines
    WHERE stocktake_id = _stocktake_id
      AND counted_quantity <> expected_quantity
      AND COALESCE(btrim(variance_reason), '') = ''
  ) THEN RAISE EXCEPTION 'Explain every stock variance before submitting'; END IF;

  UPDATE public.central_stocktakes
  SET status = 'submitted', submitted_by = auth.uid(), submitted_at = now()
  WHERE id = _stocktake_id;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'central_stocktake.submitted', 'central_stocktakes', _stocktake_id::text, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_central_stocktake(_stocktake_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stocktake public.central_stocktakes%ROWTYPE;
  v_line record;
  v_movement_count integer := 0;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Not authorized to approve a Central stocktake'; END IF;

  SELECT * INTO v_stocktake FROM public.central_stocktakes
  WHERE id = _stocktake_id FOR UPDATE;
  IF NOT FOUND OR v_stocktake.status <> 'submitted' THEN
    RAISE EXCEPTION 'Only a submitted stocktake can be approved';
  END IF;

  FOR v_line IN
    SELECT * FROM public.central_stocktake_lines
    WHERE stocktake_id = _stocktake_id AND difference <> 0
    FOR UPDATE
  LOOP
    INSERT INTO public.inventory_movements (
      item_id, type, quantity, reason, location_id, source, performed_by
    )
    VALUES (
      v_line.item_id,
      CASE WHEN v_line.difference > 0 THEN 'adjustment_in' ELSE 'adjustment_out' END,
      abs(v_line.difference),
      'Central stocktake ' || v_stocktake.count_number || ': ' || v_line.variance_reason,
      v_stocktake.location_id,
      'central_stocktake:' || v_stocktake.id::text || ':' || v_line.id::text,
      auth.uid()
    );
    v_movement_count := v_movement_count + 1;
  END LOOP;

  UPDATE public.central_stocktakes
  SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = _stocktake_id;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(), 'central_stocktake.approved', 'central_stocktakes', _stocktake_id::text,
    jsonb_build_object('adjustment_movements', v_movement_count)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_central_stocktake(
  _stocktake_id uuid,
  _reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Not authorized to reject a Central stocktake'; END IF;
  IF COALESCE(btrim(_reason), '') = '' THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;

  UPDATE public.central_stocktakes
  SET status = 'rejected', rejection_reason = btrim(_reason),
      reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = _stocktake_id AND status = 'submitted';
  IF NOT FOUND THEN RAISE EXCEPTION 'Only a submitted stocktake can be rejected'; END IF;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(), 'central_stocktake.rejected', 'central_stocktakes', _stocktake_id::text,
    jsonb_build_object('reason', btrim(_reason))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_central_stocktake(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_central_stocktake_lines(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_central_stocktake(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_central_stocktake(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_central_stocktake(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_central_stocktake(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_central_stocktake_lines(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_central_stocktake(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_central_stocktake(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_central_stocktake(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Packaging-first production
-- ---------------------------------------------------------------------------

ALTER TABLE public.production_batches
  ADD COLUMN IF NOT EXISTS packaging_setup_id uuid REFERENCES public.recipes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS packaging_setup_missing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS packaging_exception_reason text;

ALTER TABLE public.production_consumption
  ADD COLUMN IF NOT EXISTS expected_quantity numeric(14,3),
  ADD COLUMN IF NOT EXISTS waste_quantity numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS variance_reason text;

CREATE OR REPLACE FUNCTION public.record_packaged_production(
  _product_item_id uuid,
  _quantity numeric,
  _batch_number text,
  _consumption jsonb,
  _packaging_exception_reason text DEFAULT NULL,
  _qc_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_id uuid;
  v_location_id uuid;
  v_setup_id uuid;
  v_expected_component_count integer := 0;
  v_row jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_expected numeric;
  v_waste numeric;
  v_reason text;
  v_current numeric;
  v_item_name text;
  v_item_category text;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','admin','management','operations_manager','production']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Not authorized to record production'; END IF;
  IF COALESCE(btrim(_batch_number), '') = '' THEN RAISE EXCEPTION 'Batch number is required'; END IF;
  IF _quantity IS NULL OR _quantity <= 0 THEN RAISE EXCEPTION 'Output quantity must be greater than zero'; END IF;
  IF _consumption IS NULL OR jsonb_typeof(_consumption) <> 'array' OR jsonb_array_length(_consumption) = 0 THEN
    RAISE EXCEPTION 'Record the packaging and consumables used for this batch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(_consumption) line
    GROUP BY line ->> 'item_id' HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'Each packaging item may appear only once'; END IF;
  IF EXISTS (SELECT 1 FROM public.production_batches WHERE batch_number = btrim(_batch_number)) THEN
    RAISE EXCEPTION 'Batch number % has already been recorded', btrim(_batch_number);
  END IF;

  SELECT id INTO v_location_id
  FROM public.locations
  WHERE status = 'active' AND (is_default OR lower(name) = 'main store')
  ORDER BY is_default DESC, created_at
  LIMIT 1;
  IF v_location_id IS NULL THEN RAISE EXCEPTION 'Main Store location is not configured'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_items
    WHERE id = _product_item_id AND status = 'active' AND category = 'finished_good'
  ) THEN RAISE EXCEPTION 'Select an active finished product'; END IF;

  SELECT recipe.id INTO v_setup_id
  FROM public.recipes recipe
  WHERE recipe.product_item_id = _product_item_id
    AND recipe.status = 'approved'
    AND EXISTS (
      SELECT 1
      FROM public.recipe_ingredients component
      JOIN public.inventory_items item ON item.id = component.ingredient_item_id
      WHERE component.recipe_id = recipe.id
        AND item.category IN ('packaging', 'consumable')
    )
  ORDER BY recipe.version DESC
  LIMIT 1;

  IF v_setup_id IS NULL AND COALESCE(btrim(_packaging_exception_reason), '') = '' THEN
    RAISE EXCEPTION 'This product has no approved Packaging Setup; enter an exception reason';
  END IF;

  IF v_setup_id IS NOT NULL THEN
    SELECT count(*) INTO v_expected_component_count
    FROM public.recipe_ingredients component
    JOIN public.inventory_items item ON item.id = component.ingredient_item_id
    WHERE component.recipe_id = v_setup_id
      AND item.category IN ('packaging', 'consumable');

    IF (
      SELECT count(*)
      FROM jsonb_array_elements(_consumption) line
      JOIN public.recipe_ingredients component
        ON component.recipe_id = v_setup_id
       AND component.ingredient_item_id = (line ->> 'item_id')::uuid
      JOIN public.inventory_items item ON item.id = component.ingredient_item_id
      WHERE item.category IN ('packaging', 'consumable')
    ) <> v_expected_component_count THEN
      RAISE EXCEPTION 'Record every item in the approved Packaging Setup';
    END IF;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_consumption)
  LOOP
    BEGIN
      v_item_id := (v_row ->> 'item_id')::uuid;
      v_qty := (v_row ->> 'quantity')::numeric;
      v_expected := NULLIF(v_row ->> 'expected_quantity', '')::numeric;
      v_waste := COALESCE(NULLIF(v_row ->> 'waste_quantity', '')::numeric, 0);
      v_reason := NULLIF(btrim(v_row ->> 'variance_reason'), '');
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Every packaging line needs valid quantities';
    END;

    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0 OR v_waste < 0 THEN
      RAISE EXCEPTION 'Packaging quantities must be valid and greater than zero';
    END IF;

    SELECT name, category::text INTO v_item_name, v_item_category
    FROM public.inventory_items
    WHERE id = v_item_id AND status = 'active';
    IF v_item_name IS NULL OR v_item_category NOT IN ('packaging', 'consumable') THEN
      RAISE EXCEPTION 'Production currently accepts only packaging and consumable items';
    END IF;

    IF v_expected IS NOT NULL AND (v_qty <> v_expected OR v_waste > 0) AND v_reason IS NULL THEN
      RAISE EXCEPTION 'Explain packaging variance or waste for %', v_item_name;
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(v_item_id::text || ':' || v_location_id::text, 0)
    );
    SELECT COALESCE((
      SELECT on_hand FROM public.v_item_location_stock
      WHERE item_id = v_item_id AND location_id = v_location_id
    ), 0) INTO v_current;
    IF v_current < v_qty THEN
      RAISE EXCEPTION 'Insufficient Main Store stock for %: have %, need %',
        v_item_name, v_current, v_qty;
    END IF;
  END LOOP;

  INSERT INTO public.production_batches (
    batch_number, product_item_id, quantity_produced, qc_notes, staff_id, status,
    packaging_setup_id, packaging_setup_missing, packaging_exception_reason
  )
  VALUES (
    btrim(_batch_number), _product_item_id, _quantity,
    NULLIF(btrim(_qc_notes), ''), auth.uid(), 'completed',
    v_setup_id, v_setup_id IS NULL, NULLIF(btrim(_packaging_exception_reason), '')
  )
  RETURNING id INTO v_batch_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_consumption)
  LOOP
    v_item_id := (v_row ->> 'item_id')::uuid;
    v_qty := (v_row ->> 'quantity')::numeric;
    v_expected := NULLIF(v_row ->> 'expected_quantity', '')::numeric;
    v_waste := COALESCE(NULLIF(v_row ->> 'waste_quantity', '')::numeric, 0);
    v_reason := NULLIF(btrim(v_row ->> 'variance_reason'), '');

    INSERT INTO public.production_consumption (
      production_batch_id, item_id, quantity_used,
      expected_quantity, waste_quantity, variance_reason
    )
    VALUES (v_batch_id, v_item_id, v_qty, v_expected, v_waste, v_reason);

    INSERT INTO public.inventory_movements (
      item_id, type, quantity, reason, related_production_batch,
      location_id, source, performed_by
    )
    VALUES (
      v_item_id, 'production_consume', v_qty,
      'Packaging used by batch ' || btrim(_batch_number), v_batch_id,
      v_location_id, 'production:' || v_batch_id::text || ':packaging:' || v_item_id::text,
      auth.uid()
    );
  END LOOP;

  INSERT INTO public.inventory_movements (
    item_id, type, quantity, reason, related_production_batch,
    location_id, source, performed_by
  )
  VALUES (
    _product_item_id, 'production_output', _quantity,
    'Produced by batch ' || btrim(_batch_number), v_batch_id,
    v_location_id, 'production:' || v_batch_id::text || ':output', auth.uid()
  );

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(), 'production.packaging_recorded', 'production_batches', v_batch_id::text,
    jsonb_build_object(
      'batch_number', btrim(_batch_number),
      'quantity', _quantity,
      'product_item_id', _product_item_id,
      'packaging_setup_id', v_setup_id,
      'packaging_setup_missing', v_setup_id IS NULL,
      'packaging_lines', jsonb_array_length(_consumption)
    )
  );

  RETURN v_batch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_packaged_production(uuid, numeric, text, jsonb, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_packaged_production(uuid, numeric, text, jsonb, text, text)
  TO authenticated;

-- The old function remains as a compatibility wrapper during deployment, but
-- now follows the packaging-only rules and requires notes when setup is absent.
CREATE OR REPLACE FUNCTION public.record_production(
  _product_item_id uuid,
  _quantity numeric,
  _batch_number text,
  _consumption jsonb,
  _qc_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.record_packaged_production(
    _product_item_id,
    _quantity,
    _batch_number,
    _consumption,
    _qc_notes,
    _qc_notes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_production(uuid, numeric, text, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_production(uuid, numeric, text, jsonb, text)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- Factory return events and frequency reporting
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.dispatch_return_number_seq START 1;

CREATE TABLE IF NOT EXISTS public.dispatch_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number text NOT NULL UNIQUE DEFAULT (
    'RET-' || to_char(current_date, 'YYYYMMDD') || '-' ||
    lpad(nextval('public.dispatch_return_number_seq')::text, 4, '0')
  ),
  client_reference_id text NOT NULL UNIQUE,
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  condition_notes text,
  recorded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dispatch_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES public.dispatch_returns(id) ON DELETE RESTRICT,
  dispatch_line_id uuid NOT NULL REFERENCES public.dispatch_lines(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  quantity_returned numeric(14,3) NOT NULL CHECK (quantity_returned > 0),
  quantity_accepted numeric(14,3) NOT NULL CHECK (quantity_accepted >= 0),
  quantity_rejected numeric(14,3) NOT NULL CHECK (quantity_rejected >= 0),
  CHECK (quantity_accepted + quantity_rejected = quantity_returned)
);

CREATE INDEX IF NOT EXISTS dispatch_returns_dispatch_idx
  ON public.dispatch_returns(dispatch_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS dispatch_return_lines_return_idx
  ON public.dispatch_return_lines(return_id, item_id);

GRANT SELECT ON public.dispatch_returns, public.dispatch_return_lines TO authenticated;
GRANT ALL ON public.dispatch_returns, public.dispatch_return_lines TO service_role;
ALTER TABLE public.dispatch_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_return_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dispatch_returns_read ON public.dispatch_returns;
CREATE POLICY dispatch_returns_read
  ON public.dispatch_returns FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS dispatch_return_lines_read ON public.dispatch_return_lines;
CREATE POLICY dispatch_return_lines_read
  ON public.dispatch_return_lines FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.record_factory_return(
  _dispatch_id uuid,
  _client_reference_id text,
  _lines jsonb,
  _reason text,
  _condition_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dispatch public.dispatches%ROWTYPE;
  v_return_id uuid;
  v_row jsonb;
  v_line_id uuid;
  v_item_id uuid;
  v_returned numeric;
  v_accepted numeric;
  v_rejected numeric;
  v_remaining numeric;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Not authorized to record factory returns'; END IF;
  IF COALESCE(btrim(_client_reference_id), '') = '' THEN RAISE EXCEPTION 'Client reference is required'; END IF;
  IF COALESCE(btrim(_reason), '') = '' THEN RAISE EXCEPTION 'Return reason is required'; END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'Record at least one returned item';
  END IF;

  SELECT id INTO v_return_id FROM public.dispatch_returns
  WHERE client_reference_id = btrim(_client_reference_id);
  IF v_return_id IS NOT NULL THEN RETURN v_return_id; END IF;

  SELECT * INTO v_dispatch FROM public.dispatches
  WHERE id = _dispatch_id FOR UPDATE;
  IF NOT FOUND OR v_dispatch.shop_id IS NULL THEN RAISE EXCEPTION 'Shop dispatch not found'; END IF;
  IF v_dispatch.status NOT IN ('received', 'reconciled') THEN
    RAISE EXCEPTION 'Confirm delivery before recording a return';
  END IF;
  IF v_dispatch.source_location_id IS NULL THEN
    RAISE EXCEPTION 'The factory source location is not configured';
  END IF;

  INSERT INTO public.dispatch_returns (
    client_reference_id, dispatch_id, reason, condition_notes, recorded_by
  )
  VALUES (
    btrim(_client_reference_id), v_dispatch.id, btrim(_reason),
    NULLIF(btrim(_condition_notes), ''), auth.uid()
  )
  RETURNING id INTO v_return_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines)
  LOOP
    v_line_id := (v_row ->> 'line_id')::uuid;
    v_returned := (v_row ->> 'quantity_returned')::numeric;
    v_accepted := (v_row ->> 'quantity_accepted')::numeric;
    v_rejected := (v_row ->> 'quantity_rejected')::numeric;
    IF v_returned IS NULL OR v_accepted IS NULL OR v_rejected IS NULL
       OR v_returned <= 0 OR v_accepted < 0 OR v_rejected < 0
       OR v_accepted + v_rejected <> v_returned THEN
      RAISE EXCEPTION 'Accepted and rejected quantities must equal the returned quantity';
    END IF;

    SELECT item_id, quantity_dispatched - quantity_returned
    INTO v_item_id, v_remaining
    FROM public.dispatch_lines
    WHERE id = v_line_id AND dispatch_id = v_dispatch.id
    FOR UPDATE;
    IF v_item_id IS NULL THEN RAISE EXCEPTION 'Dispatch line % was not found', v_line_id; END IF;
    IF v_returned > v_remaining THEN
      RAISE EXCEPTION 'Return quantity % exceeds the unreturned dispatch quantity %',
        v_returned, v_remaining;
    END IF;

    INSERT INTO public.dispatch_return_lines (
      return_id, dispatch_line_id, item_id,
      quantity_returned, quantity_accepted, quantity_rejected
    )
    VALUES (v_return_id, v_line_id, v_item_id, v_returned, v_accepted, v_rejected);

    UPDATE public.dispatch_lines
    SET quantity_returned = quantity_returned + v_returned
    WHERE id = v_line_id;

    IF v_accepted > 0 THEN
      INSERT INTO public.inventory_movements (
        item_id, type, quantity, reason, dispatch_id, location_id, source,
        from_shop_id, performed_by
      )
      VALUES (
        v_item_id, 'stock_in', v_accepted,
        'Accepted factory return ' || (SELECT return_number FROM public.dispatch_returns WHERE id = v_return_id),
        v_dispatch.id, v_dispatch.source_location_id,
        'factory_return:' || v_return_id::text || ':' || v_line_id::text,
        v_dispatch.shop_id, auth.uid()
      );
    END IF;
  END LOOP;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(), 'dispatch.factory_return_recorded', 'dispatch_returns', v_return_id::text,
    jsonb_build_object('dispatch_id', v_dispatch.id, 'reason', btrim(_reason), 'lines', _lines)
  );

  RETURN v_return_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_factory_return(uuid, text, jsonb, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_factory_return(uuid, text, jsonb, text, text)
  TO authenticated;

-- Keep the previous RPC callable by an older client during deployment, while
-- routing it through the new event model with all returned units accepted.
CREATE OR REPLACE FUNCTION public.record_shop_return(
  _dispatch_id uuid,
  _lines jsonb,
  _reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_lines jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
    'line_id', line ->> 'line_id',
    'quantity_returned', (line ->> 'quantity')::numeric,
    'quantity_accepted', (line ->> 'quantity')::numeric,
    'quantity_rejected', 0
  )) INTO v_lines
  FROM jsonb_array_elements(_lines) line
  WHERE COALESCE((line ->> 'quantity')::numeric, 0) > 0;

  PERFORM public.record_factory_return(
    _dispatch_id,
    'legacy-return:' || gen_random_uuid()::text,
    v_lines,
    COALESCE(NULLIF(btrim(_reason), ''), 'Return from shop'),
    'Recorded by compatibility workflow'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_shop_return(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_shop_return(uuid, jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Reporting views
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public.v_production_report;
CREATE VIEW public.v_production_report
WITH (security_invoker = true)
AS
SELECT
  batch.id AS batch_id,
  batch.batch_number,
  batch.produced_at,
  batch.status,
  batch.qc_notes,
  batch.quantity_produced,
  batch.product_item_id,
  product.sku AS product_sku,
  product.name AS product_name,
  product.unit AS product_unit,
  output_movement.location_id,
  production_location.name AS location_name,
  batch.staff_id,
  COALESCE(operator.full_name, operator.email) AS staff_name,
  batch.packaging_setup_id,
  batch.packaging_setup_missing,
  batch.packaging_exception_reason,
  consumption.id AS consumption_id,
  consumption.item_id AS material_item_id,
  material.sku AS material_sku,
  material.name AS material_name,
  material.unit AS material_unit,
  material.category AS material_category,
  consumption.quantity_used,
  consumption.expected_quantity,
  consumption.waste_quantity,
  consumption.quantity_used - COALESCE(consumption.expected_quantity, consumption.quantity_used)
    AS packaging_variance,
  consumption.variance_reason
FROM public.production_batches batch
JOIN public.inventory_items product ON product.id = batch.product_item_id
LEFT JOIN LATERAL (
  SELECT movement.location_id
  FROM public.inventory_movements movement
  WHERE movement.related_production_batch = batch.id
    AND movement.type = 'production_output'
  ORDER BY movement.created_at DESC
  LIMIT 1
) output_movement ON true
LEFT JOIN public.locations production_location
  ON production_location.id = output_movement.location_id
LEFT JOIN public.profiles operator ON operator.id = batch.staff_id
LEFT JOIN public.production_consumption consumption
  ON consumption.production_batch_id = batch.id
LEFT JOIN public.inventory_items material ON material.id = consumption.item_id;

CREATE OR REPLACE VIEW public.v_dispatch_return_report
WITH (security_invoker = true)
AS
SELECT
  returned.id AS return_id,
  returned.return_number,
  returned.recorded_at,
  returned.reason,
  returned.condition_notes,
  returned.dispatch_id,
  dispatch.reference AS dispatch_reference,
  dispatch.dispatched_at,
  dispatch.shop_id,
  shop.name AS shop_name,
  dispatch.source_location_id,
  source_location.name AS source_location,
  line.id AS return_line_id,
  line.item_id,
  item.sku,
  item.name AS item_name,
  item.unit,
  line.quantity_returned,
  line.quantity_accepted,
  line.quantity_rejected,
  returned.recorded_by,
  COALESCE(recorder.full_name, recorder.email) AS recorded_by_name
FROM public.dispatch_returns returned
JOIN public.dispatch_return_lines line ON line.return_id = returned.id
JOIN public.dispatches dispatch ON dispatch.id = returned.dispatch_id
JOIN public.inventory_items item ON item.id = line.item_id
LEFT JOIN public.shops shop ON shop.id = dispatch.shop_id
LEFT JOIN public.locations source_location ON source_location.id = dispatch.source_location_id
LEFT JOIN public.profiles recorder ON recorder.id = returned.recorded_by;

GRANT SELECT ON public.v_production_report, public.v_dispatch_return_report TO authenticated;
NOTIFY pgrst, 'reload schema';
