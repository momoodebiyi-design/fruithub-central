-- Make production atomic and location-aware, repair live-test batches, and
-- expose a flattened production report for the operational reporting screen.

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
DECLARE
  v_batch_id uuid;
  v_location_id uuid;
  v_row jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_current numeric;
  v_item_name text;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','admin','management','operations_manager','production']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorized to record production';
  END IF;

  IF COALESCE(btrim(_batch_number), '') = '' THEN
    RAISE EXCEPTION 'Batch number is required';
  END IF;
  IF _quantity IS NULL OR _quantity <= 0 THEN
    RAISE EXCEPTION 'Output quantity must be greater than zero';
  END IF;
  IF _consumption IS NULL OR jsonb_typeof(_consumption) <> 'array' THEN
    RAISE EXCEPTION 'Consumed materials must be provided as a list';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(_consumption) line
    GROUP BY line ->> 'item_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Each consumed material may appear only once';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.production_batches WHERE batch_number = btrim(_batch_number)
  ) THEN
    RAISE EXCEPTION 'Batch number % has already been recorded', btrim(_batch_number);
  END IF;

  SELECT id INTO v_location_id
  FROM public.locations
  WHERE status = 'active'
    AND (is_default OR lower(name) = 'main store')
  ORDER BY is_default DESC, created_at
  LIMIT 1;

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'Main Store location is not configured';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_items
    WHERE id = _product_item_id AND status = 'active' AND category = 'finished_good'
  ) THEN
    RAISE EXCEPTION 'Select an active finished product as the batch output';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_consumption)
  LOOP
    BEGIN
      v_item_id := (v_row ->> 'item_id')::uuid;
      v_qty := (v_row ->> 'quantity')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Every consumed material needs a valid item and quantity';
    END;

    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Every consumed material quantity must be greater than zero';
    END IF;
    IF v_item_id = _product_item_id THEN
      RAISE EXCEPTION 'The output product cannot also be a consumed material';
    END IF;

    SELECT name INTO v_item_name
    FROM public.inventory_items
    WHERE id = v_item_id AND status = 'active';
    IF v_item_name IS NULL THEN
      RAISE EXCEPTION 'Consumed material % is missing or inactive', v_item_id;
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(v_item_id::text || ':' || v_location_id::text, 0)
    );
    SELECT COALESCE((
      SELECT on_hand
      FROM public.v_item_location_stock
      WHERE item_id = v_item_id AND location_id = v_location_id
    ), 0) INTO v_current;

    IF v_current < v_qty THEN
      RAISE EXCEPTION 'Insufficient Main Store stock for %: have %, need %',
        v_item_name, v_current, v_qty;
    END IF;
  END LOOP;

  INSERT INTO public.production_batches (
    batch_number, product_item_id, quantity_produced, qc_notes, staff_id, status
  )
  VALUES (
    btrim(_batch_number), _product_item_id, _quantity,
    NULLIF(btrim(_qc_notes), ''), auth.uid(), 'completed'
  )
  RETURNING id INTO v_batch_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_consumption)
  LOOP
    v_item_id := (v_row ->> 'item_id')::uuid;
    v_qty := (v_row ->> 'quantity')::numeric;

    INSERT INTO public.production_consumption (
      production_batch_id, item_id, quantity_used
    )
    VALUES (v_batch_id, v_item_id, v_qty);

    INSERT INTO public.inventory_movements (
      item_id, type, quantity, reason, related_production_batch,
      location_id, source, performed_by
    )
    VALUES (
      v_item_id, 'production_consume', v_qty,
      'Consumed by batch ' || btrim(_batch_number), v_batch_id,
      v_location_id, 'production:' || v_batch_id::text || ':consume:' || v_item_id::text,
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
    auth.uid(), 'production.recorded', 'production_batches', v_batch_id::text,
    jsonb_build_object(
      'batch_number', btrim(_batch_number),
      'quantity', _quantity,
      'product_item_id', _product_item_id,
      'location_id', v_location_id,
      'consumption_lines', jsonb_array_length(_consumption)
    )
  );

  RETURN v_batch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_production(uuid, numeric, text, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_production(uuid, numeric, text, jsonb, text)
  TO authenticated;

-- The live-test reset removed older operational history. Any remaining
-- location-less production movements therefore belong to the current pilot
-- and can be safely assigned to Main Store without changing their quantities.
DO $$
DECLARE
  v_location_id uuid;
  v_repaired integer := 0;
BEGIN
  SELECT id INTO v_location_id
  FROM public.locations
  WHERE status = 'active'
    AND (is_default OR lower(name) = 'main store')
  ORDER BY is_default DESC, created_at
  LIMIT 1;

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'Main Store location is not configured';
  END IF;

  UPDATE public.inventory_movements
  SET location_id = v_location_id,
      source = COALESCE(source, 'production_location_backfill:' || id::text)
  WHERE location_id IS NULL
    AND related_production_batch IS NOT NULL
    AND type IN ('production_consume', 'production_output');
  GET DIAGNOSTICS v_repaired = ROW_COUNT;

  IF v_repaired > 0 THEN
    INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
    VALUES (
      NULL, 'system.production_locations_repaired', 'inventory_movements',
      'live-test-production',
      jsonb_build_object('movements_repaired', v_repaired, 'location_id', v_location_id)
    );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS production_batches_produced_at_idx
  ON public.production_batches (produced_at DESC);

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
  output_movement.location_id,
  production_location.name AS location_name,
  batch.staff_id,
  COALESCE(operator.full_name, operator.email) AS staff_name,
  consumption.id AS consumption_id,
  consumption.item_id AS material_item_id,
  material.sku AS material_sku,
  material.name AS material_name,
  material.unit AS material_unit,
  consumption.quantity_used
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

GRANT SELECT ON public.v_production_report TO authenticated;
NOTIFY pgrst, 'reload schema';
