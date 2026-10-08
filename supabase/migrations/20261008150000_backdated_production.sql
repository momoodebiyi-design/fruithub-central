-- Actual production time is distinct from the time a batch is entered.
-- A later Central count may already include its output and packaging use.
ALTER TABLE public.production_batches
  ADD COLUMN IF NOT EXISTS late_entry_reason text,
  ADD COLUMN IF NOT EXISTS stocktake_treatment text
    CHECK (stocktake_treatment IN ('already_counted', 'deduct_now')),
  ADD COLUMN IF NOT EXISTS output_stock_effect text NOT NULL DEFAULT 'posted'
    CHECK (output_stock_effect IN ('posted', 'already_counted')),
  ADD COLUMN IF NOT EXISTS output_linked_stocktake_id uuid
    REFERENCES public.central_stocktakes(id) ON DELETE RESTRICT;

ALTER TABLE public.production_consumption
  ADD COLUMN IF NOT EXISTS stock_effect text NOT NULL DEFAULT 'posted'
    CHECK (stock_effect IN ('posted', 'already_counted')),
  ADD COLUMN IF NOT EXISTS linked_stocktake_id uuid
    REFERENCES public.central_stocktakes(id) ON DELETE RESTRICT;

-- Batch and consumption writes belong to the audited production operation.
REVOKE INSERT, UPDATE, DELETE ON public.production_batches FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.production_consumption FROM authenticated;

CREATE OR REPLACE FUNCTION public.guard_production_record_dates()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.produced_at IS DISTINCT FROM OLD.produced_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.late_entry_reason IS DISTINCT FROM OLD.late_entry_reason
     OR NEW.stocktake_treatment IS DISTINCT FROM OLD.stocktake_treatment
     OR NEW.output_stock_effect IS DISTINCT FROM OLD.output_stock_effect
     OR NEW.output_linked_stocktake_id IS DISTINCT FROM OLD.output_linked_stocktake_id THEN
    RAISE EXCEPTION 'Production dates and stocktake treatment cannot be edited after recording';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_production_record_dates ON public.production_batches;
CREATE TRIGGER trg_guard_production_record_dates
  BEFORE UPDATE OF produced_at, created_at, late_entry_reason, stocktake_treatment,
    output_stock_effect, output_linked_stocktake_id
  ON public.production_batches FOR EACH ROW
  EXECUTE FUNCTION public.guard_production_record_dates();

CREATE OR REPLACE FUNCTION public.preview_backdated_production_stocktakes(
  _produced_at timestamptz, _item_ids uuid[]
)
RETURNS TABLE(item_id uuid, stocktake_id uuid, count_number text, submitted_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_any_role(
    auth.uid(), ARRAY['super_admin','admin','management']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Only Management or Admin can review earlier production'; END IF;
  IF _produced_at IS NULL OR _item_ids IS NULL THEN
    RAISE EXCEPTION 'Production time and items are required';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (line.item_id)
    line.item_id, count.id, count.count_number, count.submitted_at
  FROM public.central_stocktakes count
  JOIN public.central_stocktake_lines line ON line.stocktake_id = count.id
  JOIN public.locations location ON location.id = count.location_id
  WHERE line.item_id = ANY(_item_ids)
    AND line.counted_quantity IS NOT NULL
    AND count.status IN ('posted', 'approved')
    AND COALESCE(count.submitted_at, count.reviewed_at, count.created_at) >= _produced_at
    AND location.status = 'active'
    AND (location.is_default OR lower(location.name) = 'main store')
  ORDER BY line.item_id,
    COALESCE(count.submitted_at, count.reviewed_at, count.created_at) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.preview_backdated_production_stocktakes(timestamptz, uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_backdated_production_stocktakes(timestamptz, uuid[])
  TO authenticated;

CREATE OR REPLACE FUNCTION public.record_packaged_production_with_date(
  _product_item_id uuid,
  _quantity numeric,
  _batch_number text,
  _consumption jsonb,
  _packaging_exception_reason text,
  _qc_notes text,
  _produced_at timestamptz,
  _late_entry_reason text,
  _stocktake_treatment text
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
  v_output_item_name text;
  v_output_stocktake_id uuid;
  v_stocktake_id uuid;
  v_output_effect text;
  v_line_effect text;
  v_crossed_stocktakes jsonb := '[]'::jsonb;
  v_backdated boolean;
  v_already_counted_lines integer := 0;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','admin','management','operations_manager','production']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Not authorized to record production'; END IF;
  IF _produced_at IS NULL OR _produced_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Production time must not be in the future';
  END IF;
  v_backdated := (_produced_at AT TIME ZONE 'Africa/Lagos')::date
    < (now() AT TIME ZONE 'Africa/Lagos')::date;
  IF v_backdated THEN
    IF NOT public.has_any_role(
      auth.uid(), ARRAY['super_admin','admin','management']::public.app_role[]
    ) THEN RAISE EXCEPTION 'Only Management or Admin can record previous-day production'; END IF;
    IF length(btrim(COALESCE(_late_entry_reason, ''))) < 5 THEN
      RAISE EXCEPTION 'A reason of at least 5 characters is required for earlier production';
    END IF;
  END IF;
  IF _stocktake_treatment IS NOT NULL
     AND _stocktake_treatment NOT IN ('already_counted', 'deduct_now') THEN
    RAISE EXCEPTION 'Choose a valid stocktake treatment';
  END IF;
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

  SELECT name INTO v_output_item_name FROM public.inventory_items
  WHERE id = _product_item_id AND status = 'active' AND category = 'finished_good';
  IF v_output_item_name IS NULL THEN RAISE EXCEPTION 'Select an active finished product'; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(_product_item_id::text || ':' || v_location_id::text, 0)
  );
  SELECT count.id INTO v_output_stocktake_id
  FROM public.central_stocktakes count
  JOIN public.central_stocktake_lines line ON line.stocktake_id = count.id
  WHERE count.location_id = v_location_id
    AND line.item_id = _product_item_id
    AND line.counted_quantity IS NOT NULL
    AND count.status IN ('posted', 'approved')
    AND COALESCE(count.submitted_at, count.reviewed_at, count.created_at) >= _produced_at
  ORDER BY COALESCE(count.submitted_at, count.reviewed_at, count.created_at) DESC
  LIMIT 1;
  IF v_output_stocktake_id IS NOT NULL THEN
    IF NOT public.has_any_role(
      auth.uid(), ARRAY['super_admin','admin','management']::public.app_role[]
    ) THEN RAISE EXCEPTION 'Management or Admin must reconcile a later Central stocktake'; END IF;
    IF _stocktake_treatment IS NULL THEN
      RAISE EXCEPTION 'A later posted Central stocktake covers %. Review the stock effect', v_output_item_name;
    END IF;
    v_crossed_stocktakes := v_crossed_stocktakes || jsonb_build_array(
      jsonb_build_object('item_id', _product_item_id, 'stocktake_id', v_output_stocktake_id)
    );
  END IF;
  v_output_effect := CASE
    WHEN v_output_stocktake_id IS NOT NULL AND _stocktake_treatment = 'already_counted'
      THEN 'already_counted' ELSE 'posted' END;

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
    SELECT count.id INTO v_stocktake_id
    FROM public.central_stocktakes count
    JOIN public.central_stocktake_lines line ON line.stocktake_id = count.id
    WHERE count.location_id = v_location_id
      AND line.item_id = v_item_id
      AND line.counted_quantity IS NOT NULL
      AND count.status IN ('posted', 'approved')
      AND COALESCE(count.submitted_at, count.reviewed_at, count.created_at) >= _produced_at
    ORDER BY COALESCE(count.submitted_at, count.reviewed_at, count.created_at) DESC
    LIMIT 1;
    IF v_stocktake_id IS NOT NULL THEN
      IF NOT public.has_any_role(
        auth.uid(), ARRAY['super_admin','admin','management']::public.app_role[]
      ) THEN RAISE EXCEPTION 'Management or Admin must reconcile a later Central stocktake'; END IF;
      IF _stocktake_treatment IS NULL THEN
        RAISE EXCEPTION 'A later posted Central stocktake covers %. Review the stock effect', v_item_name;
      END IF;
      v_crossed_stocktakes := v_crossed_stocktakes || jsonb_build_array(
        jsonb_build_object('item_id', v_item_id, 'stocktake_id', v_stocktake_id)
      );
    END IF;
    IF NOT (v_stocktake_id IS NOT NULL AND _stocktake_treatment = 'already_counted')
       AND v_current < v_qty THEN
      RAISE EXCEPTION 'Insufficient Main Store stock for %: have %, need %',
        v_item_name, v_current, v_qty;
    END IF;
  END LOOP;

  INSERT INTO public.production_batches (
    batch_number, product_item_id, quantity_produced, qc_notes, staff_id, status,
    packaging_setup_id, packaging_setup_missing, packaging_exception_reason,
    produced_at, late_entry_reason, stocktake_treatment,
    output_stock_effect, output_linked_stocktake_id
  )
  VALUES (
    btrim(_batch_number), _product_item_id, _quantity,
    NULLIF(btrim(_qc_notes), ''), auth.uid(), 'completed',
    v_setup_id, v_setup_id IS NULL, NULLIF(btrim(_packaging_exception_reason), ''),
    _produced_at,
    CASE WHEN v_backdated THEN btrim(_late_entry_reason) ELSE NULL END,
    CASE WHEN jsonb_array_length(v_crossed_stocktakes) > 0 THEN _stocktake_treatment ELSE NULL END,
    v_output_effect, v_output_stocktake_id
  )
  RETURNING id INTO v_batch_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_consumption)
  LOOP
    v_item_id := (v_row ->> 'item_id')::uuid;
    v_qty := (v_row ->> 'quantity')::numeric;
    v_expected := NULLIF(v_row ->> 'expected_quantity', '')::numeric;
    v_waste := COALESCE(NULLIF(v_row ->> 'waste_quantity', '')::numeric, 0);
    v_reason := NULLIF(btrim(v_row ->> 'variance_reason'), '');
    SELECT (entry ->> 'stocktake_id')::uuid INTO v_stocktake_id
    FROM jsonb_array_elements(v_crossed_stocktakes) entry
    WHERE (entry ->> 'item_id')::uuid = v_item_id
    LIMIT 1;
    v_line_effect := CASE
      WHEN v_stocktake_id IS NOT NULL AND _stocktake_treatment = 'already_counted'
        THEN 'already_counted' ELSE 'posted' END;

    INSERT INTO public.production_consumption (
      production_batch_id, item_id, quantity_used,
      expected_quantity, waste_quantity, variance_reason,
      stock_effect, linked_stocktake_id
    )
    VALUES (v_batch_id, v_item_id, v_qty, v_expected, v_waste, v_reason,
      v_line_effect, v_stocktake_id);

    IF v_line_effect = 'already_counted' THEN
      v_already_counted_lines := v_already_counted_lines + 1;
    ELSE
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
    END IF;
  END LOOP;

  IF v_output_effect = 'posted' THEN
    INSERT INTO public.inventory_movements (
      item_id, type, quantity, reason, related_production_batch,
      location_id, source, performed_by
    )
    VALUES (
      _product_item_id, 'production_output', _quantity,
      'Produced by batch ' || btrim(_batch_number), v_batch_id,
      v_location_id, 'production:' || v_batch_id::text || ':output', auth.uid()
    );
  END IF;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(),
    CASE WHEN v_backdated THEN 'production.backdated_recorded'
      ELSE 'production.packaging_recorded' END,
    'production_batches', v_batch_id::text,
    jsonb_build_object(
      'batch_number', btrim(_batch_number),
      'quantity', _quantity,
      'product_item_id', _product_item_id,
      'packaging_setup_id', v_setup_id,
      'packaging_setup_missing', v_setup_id IS NULL,
      'packaging_lines', jsonb_array_length(_consumption),
      'produced_at', _produced_at, 'recorded_at', now(),
      'late_entry_reason', CASE WHEN v_backdated THEN btrim(_late_entry_reason) ELSE NULL END,
      'stocktake_treatment', _stocktake_treatment,
      'crossed_stocktakes', v_crossed_stocktakes,
      'output_stock_effect', v_output_effect,
      'already_counted_packaging_lines', v_already_counted_lines
    )
  );

  RETURN v_batch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_packaged_production_with_date(
  uuid, numeric, text, jsonb, text, text, timestamptz, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_packaged_production_with_date(
  uuid, numeric, text, jsonb, text, text, timestamptz, text, text
) TO authenticated;

-- Retain the existing RPC for clients that have not refreshed yet.
CREATE OR REPLACE FUNCTION public.record_packaged_production(
  _product_item_id uuid, _quantity numeric, _batch_number text, _consumption jsonb,
  _packaging_exception_reason text DEFAULT NULL, _qc_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.record_packaged_production_with_date(
    _product_item_id, _quantity, _batch_number, _consumption,
    _packaging_exception_reason, _qc_notes, now(), NULL, NULL
  );
END;
$$;


CREATE OR REPLACE VIEW public.v_production_report
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
  COALESCE(output_movement.location_id, output_stocktake.location_id) AS location_id,
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
  consumption.variance_reason,
  batch.created_at AS recorded_at,
  batch.late_entry_reason,
  batch.stocktake_treatment,
  batch.output_stock_effect,
  output_stocktake.count_number AS output_linked_stocktake_number,
  consumption.stock_effect AS packaging_stock_effect,
  packaging_stocktake.count_number AS packaging_linked_stocktake_number,
  (batch.produced_at AT TIME ZONE 'Africa/Lagos')::date
    < (batch.created_at AT TIME ZONE 'Africa/Lagos')::date AS entered_late
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
LEFT JOIN public.central_stocktakes output_stocktake
  ON output_stocktake.id = batch.output_linked_stocktake_id
LEFT JOIN public.locations production_location
  ON production_location.id = COALESCE(output_movement.location_id, output_stocktake.location_id)
LEFT JOIN public.profiles operator ON operator.id = batch.staff_id
LEFT JOIN public.production_consumption consumption
  ON consumption.production_batch_id = batch.id
LEFT JOIN public.inventory_items material ON material.id = consumption.item_id
LEFT JOIN public.central_stocktakes packaging_stocktake
  ON packaging_stocktake.id = consumption.linked_stocktake_id;

GRANT SELECT ON public.v_production_report TO authenticated;

CREATE OR REPLACE VIEW public.v_inventory_movement_report
WITH (security_invoker = true) AS
SELECT
  movement.id AS movement_id,
  movement.created_at,
  (COALESCE(
    CASE WHEN movement.source LIKE 'shop_dispatch_issue:%'
           OR movement.source LIKE 'client_dispatch_issue:%'
      THEN dispatch.dispatched_at
    WHEN movement.type IN ('production_output', 'production_consume')
      AND batch.id IS NOT NULL THEN batch.produced_at END,
    movement.created_at
  ) AT TIME ZONE 'Africa/Lagos')::date AS movement_date,
  movement.type,
  CASE
    WHEN movement.type IN ('stock_in', 'opening_balance', 'receipt', 'adjustment_in', 'production_output') THEN abs(movement.quantity)
    WHEN movement.type IN ('stock_out', 'sale', 'damaged', 'expired', 'wastage', 'production_consume', 'adjustment_out') THEN -abs(movement.quantity)
    WHEN movement.type = 'adjustment' THEN movement.quantity ELSE 0
  END AS signed_quantity,
  CASE
    WHEN movement.type IN ('stock_in', 'opening_balance', 'receipt', 'adjustment_in', 'production_output') THEN 'in'
    WHEN movement.type IN ('stock_out', 'sale', 'damaged', 'expired', 'wastage', 'production_consume', 'adjustment_out') THEN 'out'
    ELSE 'adjustment'
  END AS direction,
  movement.quantity, movement.reason, movement.source, movement.location_id,
  location.name AS location_name,
  item.id AS item_id, item.sku, item.name AS item_name, item.unit,
  dispatch.reference AS dispatch_reference,
  from_shop.name AS from_shop_name, to_shop.name AS to_shop_name,
  from_client.name AS from_client_name, to_client.name AS to_client_name,
  movement.performed_by,
  COALESCE(performer.full_name, performer.email) AS performed_by_name,
  COALESCE(
    CASE WHEN movement.source LIKE 'shop_dispatch_issue:%'
           OR movement.source LIKE 'client_dispatch_issue:%'
      THEN dispatch.dispatched_at
    WHEN movement.type IN ('production_output', 'production_consume')
      AND batch.id IS NOT NULL THEN batch.produced_at END,
    movement.created_at
  ) AS occurred_at,
  CASE
    WHEN movement.source LIKE 'shop_dispatch_issue:%'
      OR movement.source LIKE 'client_dispatch_issue:%'
    THEN COALESCE(
      (dispatch.dispatched_at AT TIME ZONE 'Africa/Lagos')::date
        < (movement.created_at AT TIME ZONE 'Africa/Lagos')::date,
      false
    )
    WHEN movement.type IN ('production_output', 'production_consume')
      AND batch.id IS NOT NULL
    THEN (batch.produced_at AT TIME ZONE 'Africa/Lagos')::date
      < (movement.created_at AT TIME ZONE 'Africa/Lagos')::date
    ELSE false
  END AS entered_late
FROM public.inventory_movements movement
JOIN public.inventory_items item ON item.id = movement.item_id
LEFT JOIN public.locations location ON location.id = movement.location_id
LEFT JOIN public.dispatches dispatch ON dispatch.id = movement.dispatch_id
LEFT JOIN public.production_batches batch ON batch.id = movement.related_production_batch
LEFT JOIN public.shops from_shop ON from_shop.id = movement.from_shop_id
LEFT JOIN public.shops to_shop ON to_shop.id = movement.to_shop_id
LEFT JOIN public.clients from_client ON from_client.id = movement.from_client_id
LEFT JOIN public.clients to_client ON to_client.id = movement.to_client_id
LEFT JOIN public.profiles performer ON performer.id = movement.performed_by;

GRANT SELECT ON public.v_inventory_movement_report TO authenticated;
NOTIFY pgrst, 'reload schema';
