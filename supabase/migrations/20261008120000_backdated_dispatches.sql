-- Keep the time a shipment happened separate from the time it was recorded.
-- A later posted Central count can already contain an unrecorded shipment, so
-- each affected line records whether posting it reduced stock again.
ALTER TABLE public.dispatches
  ADD COLUMN IF NOT EXISTS late_entry_reason text,
  ADD COLUMN IF NOT EXISTS stocktake_treatment text
    CHECK (stocktake_treatment IN ('already_counted', 'deduct_now'));

ALTER TABLE public.dispatch_lines
  ADD COLUMN IF NOT EXISTS stock_effect text NOT NULL DEFAULT 'deducted'
    CHECK (stock_effect IN ('deducted', 'already_counted')),
  ADD COLUMN IF NOT EXISTS linked_stocktake_id uuid
    REFERENCES public.central_stocktakes(id) ON DELETE RESTRICT;

-- The creation and receipt functions own dispatch mutations. These grants and
-- guards prevent a signed-in client from rewriting the actual or recorded date.
REVOKE INSERT, DELETE ON public.dispatches FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.dispatch_lines FROM authenticated;

CREATE OR REPLACE FUNCTION public.guard_dispatch_record_dates()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.late_entry_reason IS DISTINCT FROM OLD.late_entry_reason
     OR NEW.stocktake_treatment IS DISTINCT FROM OLD.stocktake_treatment THEN
    RAISE EXCEPTION 'Dispatch dates and reconciliation cannot be edited after creation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_dispatch_record_dates ON public.dispatches;
CREATE TRIGGER trg_guard_dispatch_record_dates
  BEFORE UPDATE OF dispatched_at, created_at, late_entry_reason, stocktake_treatment
  ON public.dispatches FOR EACH ROW
  EXECUTE FUNCTION public.guard_dispatch_record_dates();

CREATE OR REPLACE FUNCTION public.preview_backdated_dispatch_stocktakes(
  _dispatched_at timestamptz,
  _item_ids uuid[]
)
RETURNS TABLE(item_id uuid, stocktake_id uuid, count_number text, submitted_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','admin','management']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Only Management or Admin can review earlier dispatches'; END IF;
  IF _dispatched_at IS NULL OR _item_ids IS NULL THEN
    RAISE EXCEPTION 'Dispatch time and items are required';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (line.item_id)
    line.item_id, count.id, count.count_number, count.submitted_at
  FROM public.central_stocktakes count
  JOIN public.central_stocktake_lines line ON line.stocktake_id = count.id
  JOIN public.locations location ON location.id = count.location_id
  WHERE line.item_id = ANY(_item_ids)
    AND count.status IN ('posted', 'approved')
    AND COALESCE(count.submitted_at, count.reviewed_at, count.created_at) >= _dispatched_at
    AND location.status = 'active'
    AND (location.is_default OR lower(location.name) = 'main store')
  ORDER BY line.item_id,
    COALESCE(count.submitted_at, count.reviewed_at, count.created_at) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.preview_backdated_dispatch_stocktakes(timestamptz, uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_backdated_dispatch_stocktakes(timestamptz, uuid[])
  TO authenticated;

CREATE OR REPLACE FUNCTION public.create_dispatch_with_date(
  _shop_id uuid,
  _client_id uuid,
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
  IF (_shop_id IS NOT NULL)::integer + (_client_id IS NOT NULL)::integer <> 1 THEN
    RAISE EXCEPTION 'Dispatch must have exactly one destination (shop or client)';
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

  IF _shop_id IS NOT NULL THEN
    SELECT location.id, 'shop ' || shop.name
    INTO v_destination_location_id, v_destination_label
    FROM public.shops shop
    LEFT JOIN public.locations location
      ON location.shop_id = shop.id AND location.status = 'active'
    WHERE shop.id = _shop_id AND shop.is_active
    ORDER BY location.created_at LIMIT 1;
    IF v_destination_location_id IS NULL THEN
      RAISE EXCEPTION 'The destination shop does not have an active inventory location';
    END IF;
  ELSE
    SELECT 'client ' || name INTO v_destination_label
    FROM public.clients WHERE id = _client_id AND is_active;
    IF v_destination_label IS NULL THEN
      RAISE EXCEPTION 'The destination client is not active';
    END IF;
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
    reference, shop_id, client_id, vehicle, notes, invoice_url, invoice_number,
    status, dispatched_by, source_location_id, destination_location_id,
    dispatched_at, late_entry_reason, stocktake_treatment
  ) VALUES (
    btrim(_reference), _shop_id, _client_id, NULLIF(btrim(_vehicle), ''),
    NULLIF(btrim(_notes), ''), _invoice_url, NULLIF(btrim(_invoice_number), ''),
    'dispatched', auth.uid(), v_source_location_id, v_destination_location_id,
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
        to_shop_id, to_client_id, performed_by
      ) VALUES (
        v_item_id, 'stock_out', v_qty,
        'Dispatch ' || btrim(_reference) || ' to ' || v_destination_label,
        v_dispatch_id, v_source_location_id,
        CASE WHEN _shop_id IS NOT NULL THEN 'shop_dispatch_issue:'
          ELSE 'client_dispatch_issue:' END
          || v_dispatch_id::text || ':' || v_dispatch_line_id::text,
        _shop_id, _client_id, auth.uid()
      );
    END IF;
  END LOOP;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(),
    CASE WHEN v_backdated THEN 'dispatch.backdated_created' ELSE 'dispatch.created' END,
    'dispatches', v_dispatch_id::text,
    jsonb_build_object(
      'reference', btrim(_reference), 'shop_id', _shop_id, 'client_id', _client_id,
      'dispatched_at', _dispatched_at, 'recorded_at', now(),
      'late_entry_reason', CASE WHEN v_backdated THEN btrim(_late_entry_reason) ELSE NULL END,
      'stocktake_treatment', _stocktake_treatment,
      'crossed_stocktakes', v_crossed_stocktakes,
      'already_counted_lines', v_already_counted,
      'source_location_id', v_source_location_id,
      'destination_location_id', v_destination_location_id, 'lines', _lines
    )
  );
  RETURN v_dispatch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_dispatch_with_date(
  uuid, uuid, text, text, text, text, text, jsonb, timestamptz, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_dispatch_with_date(
  uuid, uuid, text, text, text, text, text, jsonb, timestamptz, text, text
) TO authenticated;

-- Keep older clients working while a freshly deployed page loads.
CREATE OR REPLACE FUNCTION public.create_dispatch(
  _shop_id uuid, _client_id uuid, _reference text, _vehicle text,
  _notes text, _invoice_url text, _invoice_number text, _lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.create_dispatch_with_date(
    _shop_id, _client_id, _reference, _vehicle, _notes, _invoice_url,
    _invoice_number, _lines, now(), NULL, NULL
  );
END;
$$;

-- Dispatch reports use the actual event time and visibly expose late entries
-- and stocktake treatment. Old records retain their original default values.
CREATE OR REPLACE VIEW public.v_daily_dispatch_report
WITH (security_invoker = true) AS
SELECT
  dispatch.id AS dispatch_id, dispatch.reference, dispatch.dispatched_at,
  dispatch.received_at, dispatch.status,
  CASE WHEN dispatch.shop_id IS NOT NULL THEN 'shop' ELSE 'bulk_client' END AS destination_type,
  COALESCE(shop.name, client.name) AS destination_name,
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
    < (dispatch.created_at AT TIME ZONE 'Africa/Lagos')::date AS entered_late
FROM public.dispatches dispatch
JOIN public.dispatch_lines line ON line.dispatch_id = dispatch.id
JOIN public.inventory_items item ON item.id = line.item_id
LEFT JOIN public.shops shop ON shop.id = dispatch.shop_id
LEFT JOIN public.clients client ON client.id = dispatch.client_id
LEFT JOIN public.locations source_location ON source_location.id = dispatch.source_location_id
LEFT JOIN public.locations destination_location ON destination_location.id = dispatch.destination_location_id
LEFT JOIN public.profiles dispatcher ON dispatcher.id = dispatch.dispatched_by
LEFT JOIN public.profiles receiver ON receiver.id = dispatch.received_by
LEFT JOIN public.central_stocktakes stocktake ON stocktake.id = line.linked_stocktake_id;

GRANT SELECT ON public.v_daily_dispatch_report TO authenticated;

CREATE OR REPLACE VIEW public.v_inventory_movement_report
WITH (security_invoker = true) AS
SELECT
  movement.id AS movement_id,
  movement.created_at,
  (COALESCE(
    CASE WHEN movement.source LIKE 'shop_dispatch_issue:%'
           OR movement.source LIKE 'client_dispatch_issue:%'
      THEN dispatch.dispatched_at END,
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
      THEN dispatch.dispatched_at END,
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
    ELSE false
  END AS entered_late
FROM public.inventory_movements movement
JOIN public.inventory_items item ON item.id = movement.item_id
LEFT JOIN public.locations location ON location.id = movement.location_id
LEFT JOIN public.dispatches dispatch ON dispatch.id = movement.dispatch_id
LEFT JOIN public.shops from_shop ON from_shop.id = movement.from_shop_id
LEFT JOIN public.shops to_shop ON to_shop.id = movement.to_shop_id
LEFT JOIN public.clients from_client ON from_client.id = movement.from_client_id
LEFT JOIN public.clients to_client ON to_client.id = movement.to_client_id
LEFT JOIN public.profiles performer ON performer.id = movement.performed_by;

GRANT SELECT ON public.v_inventory_movement_report TO authenticated;
NOTIFY pgrst, 'reload schema';
