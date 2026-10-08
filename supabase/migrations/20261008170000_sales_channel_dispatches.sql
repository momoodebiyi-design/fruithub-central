-- Sales channels are Central stock outflows, not inventory-holding shops.
CREATE TABLE IF NOT EXISTS public.sales_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  default_charge_mode text NOT NULL DEFAULT 'chargeable'
    CHECK (default_charge_mode IN ('chargeable', 'complimentary')),
  is_active boolean NOT NULL DEFAULT true,
  legacy_shop_id uuid UNIQUE REFERENCES public.shops(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.sales_channels TO authenticated;
GRANT ALL ON public.sales_channels TO service_role;
ALTER TABLE public.sales_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Signed in can view sales channels" ON public.sales_channels
  FOR SELECT TO authenticated USING (true);

DO $$
DECLARE v_shop public.shops%ROWTYPE;
BEGIN
  FOR v_shop IN
    SELECT * FROM public.shops
    WHERE name IN ('Family Entertainment', 'Family Purchase', 'Head Office Sales')
    FOR UPDATE
  LOOP
    IF EXISTS (SELECT 1 FROM public.dispatches WHERE shop_id = v_shop.id)
       OR EXISTS (SELECT 1 FROM public.locations WHERE shop_id = v_shop.id)
       OR EXISTS (SELECT 1 FROM public.shop_stock_counts WHERE shop_id = v_shop.id)
       OR EXISTS (SELECT 1 FROM public.stock_requests WHERE destination_shop_id = v_shop.id)
       OR EXISTS (SELECT 1 FROM public.profiles WHERE shop_id = v_shop.id)
       OR EXISTS (SELECT 1 FROM public.shop_assortments WHERE shop_id = v_shop.id)
       OR EXISTS (SELECT 1 FROM public.inventory_movements
                  WHERE from_shop_id = v_shop.id OR to_shop_id = v_shop.id)
    THEN RAISE EXCEPTION 'Cannot reclassify %: shop activity now exists', v_shop.name;
    END IF;
    INSERT INTO public.sales_channels (name, default_charge_mode, legacy_shop_id)
    VALUES (
      v_shop.name,
      CASE WHEN v_shop.name = 'Family Entertainment'
        THEN 'complimentary' ELSE 'chargeable' END,
      v_shop.id
    )
    ON CONFLICT (name) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM public.sales_channels
      WHERE name = v_shop.name AND legacy_shop_id = v_shop.id
    ) THEN
      RAISE EXCEPTION 'Sales-channel name % is already assigned elsewhere', v_shop.name;
    END IF;
    UPDATE public.shops SET is_active = false WHERE id = v_shop.id;
    INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
    VALUES (
      auth.uid(), 'sales_channel.reclassified', 'shops', v_shop.id::text,
      jsonb_build_object('shop_name', v_shop.name, 'sales_channel_name', v_shop.name)
    );
  END LOOP;
END;
$$;

-- Fresh installations may not contain the legacy shop rows.
INSERT INTO public.sales_channels (name, default_charge_mode)
VALUES
  ('Family Entertainment', 'complimentary'),
  ('Family Purchase', 'chargeable'),
  ('Head Office Sales', 'chargeable')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE public.dispatches
  ADD COLUMN IF NOT EXISTS sales_channel_id uuid
    REFERENCES public.sales_channels(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS charge_mode text
    CHECK (charge_mode IN ('chargeable', 'complimentary'));
ALTER TABLE public.dispatches DROP CONSTRAINT IF EXISTS dispatches_destination_chk;
ALTER TABLE public.dispatches ADD CONSTRAINT dispatches_destination_chk
  CHECK (
    (shop_id IS NOT NULL)::integer + (client_id IS NOT NULL)::integer
      + (sales_channel_id IS NOT NULL)::integer = 1
    AND ((sales_channel_id IS NOT NULL) = (charge_mode IS NOT NULL))
  );

CREATE OR REPLACE FUNCTION public.guard_dispatch_destination()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.shop_id IS DISTINCT FROM OLD.shop_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.sales_channel_id IS DISTINCT FROM OLD.sales_channel_id
     OR NEW.charge_mode IS DISTINCT FROM OLD.charge_mode THEN
    RAISE EXCEPTION 'Dispatch destination and charge status cannot be edited after creation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_dispatch_destination
  BEFORE UPDATE OF shop_id, client_id, sales_channel_id, charge_mode
  ON public.dispatches FOR EACH ROW EXECUTE FUNCTION public.guard_dispatch_destination();
CREATE OR REPLACE FUNCTION public.create_sales_channel_dispatch_with_date(
  _sales_channel_id uuid,
  _charge_mode text,
  _reference text,
  _vehicle text,
  _notes text,
  _invoice_url text,
  _invoice_number text,
  _lines jsonb,
  _dispatched_at timestamptz,
  _late_entry_reason text,
  _stocktake_treatment text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_dispatch_id uuid;
  v_dispatch_line_id uuid;
  v_source_location_id uuid;
  v_destination_location_id uuid;
  v_destination_label text;
  v_row jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_current numeric;
  v_item_name text;
  v_stocktake_id uuid;
  v_crossed_stocktakes jsonb := '[]'::jsonb;
  v_already_counted integer := 0;
  v_backdated boolean;
  v_line_effect text;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','admin','management','operations_manager','inventory_officer','sales']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Not authorized to create dispatches'; END IF;

  IF _dispatched_at IS NULL OR _dispatched_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Dispatch time must not be in the future';
  END IF;
  v_backdated := (_dispatched_at AT TIME ZONE 'Africa/Lagos')::date
    < (now() AT TIME ZONE 'Africa/Lagos')::date;
  IF v_backdated THEN
    IF NOT public.has_any_role(
      auth.uid(), ARRAY['super_admin','admin','management']::public.app_role[]
    ) THEN RAISE EXCEPTION 'Only Management or Admin can record a previous-day dispatch'; END IF;
    IF length(btrim(COALESCE(_late_entry_reason, ''))) < 5 THEN
      RAISE EXCEPTION 'A reason of at least 5 characters is required for an earlier dispatch';
    END IF;
  END IF;
  IF _stocktake_treatment IS NOT NULL
     AND _stocktake_treatment NOT IN ('already_counted', 'deduct_now') THEN
    RAISE EXCEPTION 'Choose a valid stocktake treatment';
  END IF;
  IF _sales_channel_id IS NULL THEN RAISE EXCEPTION 'Choose a sales channel'; END IF;
  IF _charge_mode NOT IN ('chargeable', 'complimentary') OR _charge_mode IS NULL THEN
    RAISE EXCEPTION 'Choose chargeable or complimentary';
  END IF;
  IF COALESCE(btrim(_reference), '') = '' THEN
    RAISE EXCEPTION 'Dispatch reference is required';
  END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'At least one dispatch line is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(_lines) line
    GROUP BY line ->> 'item_id' HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'Each item may appear only once on a dispatch'; END IF;

  SELECT id INTO v_source_location_id FROM public.locations
  WHERE status = 'active' AND (is_default OR lower(name) = 'main store')
  ORDER BY is_default DESC, created_at LIMIT 1;
  IF v_source_location_id IS NULL THEN
    RAISE EXCEPTION 'Main Store source location is not configured';
  END IF;

  SELECT 'sales channel ' || name INTO v_destination_label
  FROM public.sales_channels WHERE id = _sales_channel_id AND is_active;
  IF v_destination_label IS NULL THEN
    RAISE EXCEPTION 'The destination sales channel is not active';
  END IF;

  -- Lock every item before posting. The preview is advisory; this final check
  -- is authoritative if a stocktake was posted while the form was open.
  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_item_id := (v_row ->> 'item_id')::uuid;
    v_qty := (v_row ->> 'quantity')::numeric;
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Every dispatch line needs an item and positive quantity';
    END IF;
    PERFORM pg_advisory_xact_lock(
      hashtextextended(v_item_id::text || ':' || v_source_location_id::text, 0)
    );
    SELECT ii.name, COALESCE(stock.on_hand, 0)
    INTO v_item_name, v_current
    FROM public.inventory_items ii
    LEFT JOIN public.v_item_location_stock stock
      ON stock.item_id = ii.id AND stock.location_id = v_source_location_id
    WHERE ii.id = v_item_id AND ii.status = 'active' AND ii.is_active;
    IF v_item_name IS NULL THEN
      RAISE EXCEPTION 'Dispatch item % is not active', v_item_id;
    END IF;

    SELECT count.id INTO v_stocktake_id
    FROM public.central_stocktakes count
    JOIN public.central_stocktake_lines line ON line.stocktake_id = count.id
    WHERE count.location_id = v_source_location_id
      AND line.item_id = v_item_id
      AND count.status IN ('posted', 'approved')
      AND COALESCE(count.submitted_at, count.reviewed_at, count.created_at) >= _dispatched_at
    ORDER BY COALESCE(count.submitted_at, count.reviewed_at, count.created_at) DESC
    LIMIT 1;

    IF v_stocktake_id IS NOT NULL THEN
      IF NOT public.has_any_role(
        auth.uid(), ARRAY['super_admin','admin','management']::public.app_role[]
      ) THEN
        RAISE EXCEPTION 'Management or Admin must reconcile a dispatch against a later Central stocktake';
      END IF;
      IF _stocktake_treatment IS NULL THEN
        RAISE EXCEPTION 'A later posted Central stocktake covers %. Review how this dispatch should affect stock',
          v_item_name;
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

  INSERT INTO public.dispatches (
    reference, sales_channel_id, charge_mode, vehicle, notes,
    status, dispatched_by, source_location_id,
    dispatched_at, late_entry_reason, stocktake_treatment
  ) VALUES (
    btrim(_reference), _sales_channel_id, _charge_mode, NULLIF(btrim(_vehicle), ''),
    NULLIF(btrim(_notes), ''), 'dispatched', auth.uid(), v_source_location_id,
    _dispatched_at,
    CASE WHEN v_backdated THEN btrim(_late_entry_reason) ELSE NULL END,
    CASE WHEN jsonb_array_length(v_crossed_stocktakes) > 0 THEN _stocktake_treatment ELSE NULL END
  ) RETURNING id INTO v_dispatch_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_item_id := (v_row ->> 'item_id')::uuid;
    v_qty := (v_row ->> 'quantity')::numeric;
    SELECT (entry ->> 'stocktake_id')::uuid INTO v_stocktake_id
    FROM jsonb_array_elements(v_crossed_stocktakes) entry
    WHERE (entry ->> 'item_id')::uuid = v_item_id
    LIMIT 1;
    v_line_effect := CASE
      WHEN v_stocktake_id IS NOT NULL AND _stocktake_treatment = 'already_counted'
        THEN 'already_counted' ELSE 'deducted' END;

    INSERT INTO public.dispatch_lines (
      dispatch_id, item_id, quantity_dispatched, stock_effect, linked_stocktake_id
    ) VALUES (
      v_dispatch_id, v_item_id, v_qty, v_line_effect, v_stocktake_id
    ) RETURNING id INTO v_dispatch_line_id;

    IF v_line_effect = 'already_counted' THEN
      v_already_counted := v_already_counted + 1;
    ELSE
      INSERT INTO public.inventory_movements (
        item_id, type, quantity, reason, dispatch_id, location_id, source,
        performed_by
      ) VALUES (
        v_item_id, 'stock_out', v_qty,
        'Dispatch ' || btrim(_reference) || ' to ' || v_destination_label,
        v_dispatch_id, v_source_location_id,
        'sales_channel_dispatch_issue:'
          || v_dispatch_id::text || ':' || v_dispatch_line_id::text,
        auth.uid()
      );
    END IF;
  END LOOP;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(),
    CASE WHEN v_backdated THEN 'dispatch.backdated_created' ELSE 'dispatch.created' END,
    'dispatches', v_dispatch_id::text,
    jsonb_build_object(
      'reference', btrim(_reference), 'sales_channel_id', _sales_channel_id,
      'charge_mode', _charge_mode,
      'dispatched_at', _dispatched_at, 'recorded_at', now(),
      'late_entry_reason', CASE WHEN v_backdated THEN btrim(_late_entry_reason) ELSE NULL END,
      'stocktake_treatment', _stocktake_treatment,
      'crossed_stocktakes', v_crossed_stocktakes,
      'already_counted_lines', v_already_counted,
      'source_location_id', v_source_location_id,
      'destination_location_id', NULL, 'lines', _lines
    )
  );
  RETURN v_dispatch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_sales_channel_dispatch_with_date(
  uuid, text, text, text, text, text, text, jsonb, timestamptz, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sales_channel_dispatch_with_date(
  uuid, text, text, text, text, text, text, jsonb, timestamptz, text, text
) TO authenticated;
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
  IF NOT FOUND OR (v_dispatch.shop_id IS NULL AND v_dispatch.sales_channel_id IS NULL) THEN
    RAISE EXCEPTION 'Shop or sales-channel dispatch not found';
  END IF;
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
    jsonb_build_object('dispatch_id', v_dispatch.id, 'sales_channel_id', v_dispatch.sales_channel_id,
      'reason', btrim(_reason), 'lines', _lines)
  );

  RETURN v_return_id;
END;
$$;
CREATE OR REPLACE VIEW public.v_daily_dispatch_report
WITH (security_invoker = true) AS
SELECT
  dispatch.id AS dispatch_id, dispatch.reference, dispatch.dispatched_at,
  dispatch.received_at, dispatch.status,
  CASE WHEN dispatch.shop_id IS NOT NULL THEN 'shop'
    WHEN dispatch.client_id IS NOT NULL THEN 'bulk_client'
    ELSE 'sales_channel' END AS destination_type,
  COALESCE(shop.name, client.name, channel.name) AS destination_name,
  dispatch.shop_id, dispatch.client_id,
  dispatch.source_location_id, dispatch.destination_location_id,
  source_location.name AS source_location,
  destination_location.name AS destination_location,
  line.id AS dispatch_line_id, item.id AS item_id, item.sku,
  item.name AS item_name, item.unit,
  line.quantity_dispatched, line.quantity_returned,
  line.quantity_dispatched - line.quantity_returned AS net_quantity,
  COALESCE(dispatcher.full_name, dispatcher.email) AS dispatched_by_name,
  COALESCE(receiver.full_name, receiver.email) AS received_by_name,
  dispatch.created_at AS recorded_at,
  dispatch.late_entry_reason,
  line.stock_effect,
  stocktake.count_number AS linked_stocktake_number,
  (dispatch.dispatched_at AT TIME ZONE 'Africa/Lagos')::date
    < (dispatch.created_at AT TIME ZONE 'Africa/Lagos')::date AS entered_late,
  dispatch.sales_channel_id, dispatch.charge_mode
FROM public.dispatches dispatch
JOIN public.dispatch_lines line ON line.dispatch_id = dispatch.id
JOIN public.inventory_items item ON item.id = line.item_id
LEFT JOIN public.shops shop ON shop.id = dispatch.shop_id
LEFT JOIN public.clients client ON client.id = dispatch.client_id
LEFT JOIN public.sales_channels channel ON channel.id = dispatch.sales_channel_id
LEFT JOIN public.locations source_location ON source_location.id = dispatch.source_location_id
LEFT JOIN public.locations destination_location ON destination_location.id = dispatch.destination_location_id
LEFT JOIN public.profiles dispatcher ON dispatcher.id = dispatch.dispatched_by
LEFT JOIN public.profiles receiver ON receiver.id = dispatch.received_by
LEFT JOIN public.central_stocktakes stocktake ON stocktake.id = line.linked_stocktake_id;

CREATE OR REPLACE VIEW public.v_inventory_movement_report
WITH (security_invoker = true) AS
SELECT
  movement.id AS movement_id,
  movement.created_at,
  (COALESCE(
    CASE WHEN movement.source LIKE 'shop_dispatch_issue:%'
           OR movement.source LIKE 'client_dispatch_issue:%'
           OR movement.source LIKE 'sales_channel_dispatch_issue:%'
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
           OR movement.source LIKE 'sales_channel_dispatch_issue:%'
      THEN dispatch.dispatched_at
    WHEN movement.type IN ('production_output', 'production_consume')
      AND batch.id IS NOT NULL THEN batch.produced_at END,
    movement.created_at
  ) AS occurred_at,
  CASE
    WHEN movement.source LIKE 'shop_dispatch_issue:%'
      OR movement.source LIKE 'client_dispatch_issue:%'
           OR movement.source LIKE 'sales_channel_dispatch_issue:%'
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
  END AS entered_late,
  channel.name AS sales_channel_name,
  dispatch.charge_mode AS dispatch_charge_mode
FROM public.inventory_movements movement
JOIN public.inventory_items item ON item.id = movement.item_id
LEFT JOIN public.locations location ON location.id = movement.location_id
LEFT JOIN public.dispatches dispatch ON dispatch.id = movement.dispatch_id
LEFT JOIN public.sales_channels channel ON channel.id = dispatch.sales_channel_id
LEFT JOIN public.production_batches batch ON batch.id = movement.related_production_batch
LEFT JOIN public.shops from_shop ON from_shop.id = movement.from_shop_id
LEFT JOIN public.shops to_shop ON to_shop.id = movement.to_shop_id
LEFT JOIN public.clients from_client ON from_client.id = movement.from_client_id
LEFT JOIN public.clients to_client ON to_client.id = movement.to_client_id
LEFT JOIN public.profiles performer ON performer.id = movement.performed_by;

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
  COALESCE(recorder.full_name, recorder.email) AS recorded_by_name,
  CASE WHEN dispatch.shop_id IS NOT NULL THEN 'shop' ELSE 'sales_channel' END AS destination_type,
  COALESCE(shop.name, channel.name) AS destination_name
FROM public.dispatch_returns returned
JOIN public.dispatch_return_lines line ON line.return_id = returned.id
JOIN public.dispatches dispatch ON dispatch.id = returned.dispatch_id
JOIN public.inventory_items item ON item.id = line.item_id
LEFT JOIN public.shops shop ON shop.id = dispatch.shop_id
LEFT JOIN public.sales_channels channel ON channel.id = dispatch.sales_channel_id
LEFT JOIN public.locations source_location ON source_location.id = dispatch.source_location_id
LEFT JOIN public.profiles recorder ON recorder.id = returned.recorded_by;

GRANT SELECT ON public.v_daily_dispatch_report, public.v_inventory_movement_report,
  public.v_dispatch_return_report TO authenticated;
NOTIFY pgrst, 'reload schema';
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
      'sales_channel_id', v_dispatch.sales_channel_id,
      'charge_mode', v_dispatch.charge_mode,
      'shop_stock_updated', v_shop_stock_updated,
      'shop_stock_workflows_enabled', public.operational_feature_enabled('shop_stock_workflows')
    )
  );

  RETURN v_dispatch.id;
END;
$$;
