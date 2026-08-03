-- Make every shop dispatch location-aware, repair the first live-test batch,
-- and expose auditable daily dispatch and inventory-movement reports.

CREATE OR REPLACE VIEW public.v_central_item_stock
WITH (security_invoker = true)
AS
WITH central AS (
  SELECT id
  FROM public.locations
  WHERE status = 'active'
    AND (is_default OR lower(name) = 'main store')
  ORDER BY is_default DESC, created_at
  LIMIT 1
)
SELECT
  ii.id AS item_id,
  ii.item_id AS item_code,
  ii.sku,
  ii.name,
  ii.category,
  ii.subcategory,
  ii.unit,
  ii.min_level,
  ii.reorder_level,
  ii.status,
  central.id AS location_id,
  COALESCE(stock.on_hand, 0) AS on_hand
FROM public.inventory_items ii
CROSS JOIN central
LEFT JOIN public.v_item_location_stock stock
  ON stock.item_id = ii.id
 AND stock.location_id = central.id;

GRANT SELECT ON public.v_central_item_stock TO authenticated;

CREATE OR REPLACE FUNCTION public.create_dispatch(
  _shop_id uuid,
  _client_id uuid,
  _reference text,
  _vehicle text,
  _notes text,
  _invoice_url text,
  _invoice_number text,
  _lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager','inventory_officer','sales']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorized to create dispatches';
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
    SELECT 1
    FROM jsonb_array_elements(_lines) line
    GROUP BY line ->> 'item_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Each item may appear only once on a dispatch';
  END IF;

  SELECT id INTO v_source_location_id
  FROM public.locations
  WHERE status = 'active'
    AND (is_default OR lower(name) = 'main store')
  ORDER BY is_default DESC, created_at
  LIMIT 1;

  IF v_source_location_id IS NULL THEN
    RAISE EXCEPTION 'Main Store source location is not configured';
  END IF;

  IF _shop_id IS NOT NULL THEN
    SELECT l.id, 'shop ' || s.name
    INTO v_destination_location_id, v_destination_label
    FROM public.shops s
    LEFT JOIN public.locations l
      ON l.shop_id = s.id
     AND l.status = 'active'
    WHERE s.id = _shop_id
      AND s.is_active
    ORDER BY l.created_at
    LIMIT 1;

    IF v_destination_location_id IS NULL THEN
      RAISE EXCEPTION 'The destination shop does not have an active inventory location';
    END IF;
  ELSE
    SELECT 'client ' || name INTO v_destination_label
    FROM public.clients
    WHERE id = _client_id AND is_active;
    IF v_destination_label IS NULL THEN
      RAISE EXCEPTION 'The destination client is not active';
    END IF;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_item_name := NULL;
    v_current := 0;
    v_item_id := (v_row ->> 'item_id')::uuid;
    v_qty := (v_row ->> 'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Every dispatch quantity must be greater than zero';
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(v_item_id::text || ':' || v_source_location_id::text, 0)
    );

    SELECT ii.name, COALESCE(stock.on_hand, 0)
    INTO v_item_name, v_current
    FROM public.inventory_items ii
    LEFT JOIN public.v_item_location_stock stock
      ON stock.item_id = ii.id
     AND stock.location_id = v_source_location_id
    WHERE ii.id = v_item_id
      AND ii.status = 'active';

    IF v_item_name IS NULL THEN
      RAISE EXCEPTION 'Dispatch item % is not active', v_item_id;
    END IF;
    IF v_current < v_qty THEN
      RAISE EXCEPTION 'Insufficient Main Store stock for %: have %, need %',
        v_item_name, v_current, v_qty;
    END IF;
  END LOOP;

  INSERT INTO public.dispatches (
    reference, shop_id, client_id, vehicle, notes, invoice_url, invoice_number,
    status, dispatched_by, source_location_id, destination_location_id
  )
  VALUES (
    btrim(_reference), _shop_id, _client_id, NULLIF(btrim(_vehicle), ''),
    NULLIF(btrim(_notes), ''), _invoice_url, NULLIF(btrim(_invoice_number), ''),
    'dispatched', auth.uid(), v_source_location_id, v_destination_location_id
  )
  RETURNING id INTO v_dispatch_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_item_id := (v_row ->> 'item_id')::uuid;
    v_qty := (v_row ->> 'quantity')::numeric;

    INSERT INTO public.dispatch_lines (dispatch_id, item_id, quantity_dispatched)
    VALUES (v_dispatch_id, v_item_id, v_qty)
    RETURNING id INTO v_dispatch_line_id;

    INSERT INTO public.inventory_movements (
      item_id, type, quantity, reason, dispatch_id, location_id, source,
      to_shop_id, to_client_id, performed_by
    )
    VALUES (
      v_item_id, 'stock_out', v_qty,
      'Dispatch ' || btrim(_reference) || ' to ' || v_destination_label,
      v_dispatch_id, v_source_location_id,
      CASE WHEN _shop_id IS NOT NULL THEN 'shop_dispatch_issue:' ELSE 'client_dispatch_issue:' END
        || v_dispatch_id::text || ':' || v_dispatch_line_id::text,
      _shop_id, _client_id, auth.uid()
    );
  END LOOP;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(), 'dispatch.created', 'dispatches', v_dispatch_id::text,
    jsonb_build_object(
      'reference', btrim(_reference),
      'shop_id', _shop_id,
      'client_id', _client_id,
      'source_location_id', v_source_location_id,
      'destination_location_id', v_destination_location_id,
      'lines', _lines
    )
  );

  RETURN v_dispatch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_dispatch(uuid, uuid, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_dispatch(uuid, uuid, text, text, text, text, text, jsonb)
  TO authenticated;

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
  v_line public.dispatch_lines%ROWTYPE;
  v_destination_location_id uuid;
BEGIN
  IF COALESCE(btrim(_client_reference_id), '') = '' THEN
    RAISE EXCEPTION 'Client reference is required';
  END IF;

  SELECT * INTO v_dispatch
  FROM public.dispatches
  WHERE id = _dispatch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispatch not found';
  END IF;
  IF v_dispatch.status IN ('received', 'reconciled') THEN
    RETURN v_dispatch.id;
  END IF;
  IF v_dispatch.status <> 'dispatched' THEN
    RAISE EXCEPTION 'Only a dispatched shipment can be received';
  END IF;
  IF v_dispatch.replenishment_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'Receive this dispatch through the Replenishment workflow';
  END IF;

  IF v_dispatch.shop_id IS NOT NULL THEN
    IF NOT (
      public.has_any_role(
        auth.uid(),
        ARRAY['super_admin','management','operations_manager','inventory_officer','sales']::public.app_role[]
      )
      OR (
        public.has_role(auth.uid(), 'shop_supervisor')
        AND v_dispatch.shop_id = (SELECT shop_id FROM public.profiles WHERE id = auth.uid())
      )
    ) THEN
      RAISE EXCEPTION 'Not authorized to confirm this shop receipt';
    END IF;

    SELECT COALESCE(
      v_dispatch.destination_location_id,
      (SELECT id FROM public.locations
       WHERE shop_id = v_dispatch.shop_id AND status = 'active'
       ORDER BY created_at LIMIT 1)
    )
    INTO v_destination_location_id;

    IF v_destination_location_id IS NULL THEN
      RAISE EXCEPTION 'The destination shop does not have an active inventory location';
    END IF;

    FOR v_line IN
      SELECT * FROM public.dispatch_lines WHERE dispatch_id = v_dispatch.id
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.inventory_movements
        WHERE source = 'shop_dispatch_receipt:' || v_dispatch.id::text || ':' || v_line.id::text
      ) THEN
        INSERT INTO public.inventory_movements (
          item_id, type, quantity, reason, dispatch_id, location_id, source,
          to_shop_id, performed_by
        )
        VALUES (
          v_line.item_id, 'stock_in', v_line.quantity_dispatched,
          'Received dispatch ' || v_dispatch.reference,
          v_dispatch.id, v_destination_location_id,
          'shop_dispatch_receipt:' || v_dispatch.id::text || ':' || v_line.id::text,
          v_dispatch.shop_id, auth.uid()
        );
      END IF;
    END LOOP;

    UPDATE public.dispatches
    SET destination_location_id = v_destination_location_id,
        status = 'received',
        received_by = auth.uid(),
        received_at = now()
    WHERE id = v_dispatch.id;
  ELSE
    IF NOT public.has_any_role(
      auth.uid(),
      ARRAY['super_admin','management','operations_manager','inventory_officer','sales']::public.app_role[]
    ) THEN
      RAISE EXCEPTION 'Not authorized to confirm this delivery';
    END IF;

    UPDATE public.dispatches
    SET status = 'received', received_by = auth.uid(), received_at = now()
    WHERE id = v_dispatch.id;
  END IF;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(), 'dispatch.receipt_confirmed', 'dispatches', v_dispatch.id::text,
    jsonb_build_object(
      'client_reference_id', btrim(_client_reference_id),
      'shop_id', v_dispatch.shop_id,
      'destination_location_id', v_destination_location_id,
      'full_quantity_received', true
    )
  );

  RETURN v_dispatch.id;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_dispatch_receipt(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_dispatch_receipt(uuid, text) TO authenticated;

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
DECLARE
  v_dispatch public.dispatches%ROWTYPE;
  v_row jsonb;
  v_line_id uuid;
  v_item_id uuid;
  v_qty numeric;
  v_remaining numeric;
  v_shop_on_hand numeric;
  v_return_key text;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorized to record shop returns';
  END IF;

  SELECT * INTO v_dispatch
  FROM public.dispatches
  WHERE id = _dispatch_id
  FOR UPDATE;

  IF NOT FOUND OR v_dispatch.shop_id IS NULL THEN
    RAISE EXCEPTION 'Shop dispatch not found';
  END IF;
  IF v_dispatch.status NOT IN ('received', 'reconciled') THEN
    RAISE EXCEPTION 'The shop must confirm receipt before recording a return';
  END IF;
  IF v_dispatch.source_location_id IS NULL OR v_dispatch.destination_location_id IS NULL THEN
    RAISE EXCEPTION 'Dispatch locations are not configured';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_item_id := NULL;
    v_remaining := NULL;
    v_line_id := (v_row ->> 'line_id')::uuid;
    v_qty := (v_row ->> 'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      CONTINUE;
    END IF;

    SELECT item_id, quantity_dispatched - quantity_returned
    INTO v_item_id, v_remaining
    FROM public.dispatch_lines
    WHERE id = v_line_id AND dispatch_id = v_dispatch.id
    FOR UPDATE;

    IF v_item_id IS NULL THEN
      RAISE EXCEPTION 'Dispatch line % not found', v_line_id;
    END IF;
    IF v_qty > v_remaining THEN
      RAISE EXCEPTION 'Return quantity % exceeds remaining % on line', v_qty, v_remaining;
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(v_item_id::text || ':' || v_dispatch.destination_location_id::text, 0)
    );
    SELECT COALESCE(on_hand, 0) INTO v_shop_on_hand
    FROM public.v_item_location_stock
    WHERE item_id = v_item_id AND location_id = v_dispatch.destination_location_id;
    v_shop_on_hand := COALESCE(v_shop_on_hand, 0);
    IF v_shop_on_hand < v_qty THEN
      RAISE EXCEPTION 'Shop stock is insufficient for this return: have %, need %',
        v_shop_on_hand, v_qty;
    END IF;

    UPDATE public.dispatch_lines
    SET quantity_returned = quantity_returned + v_qty
    WHERE id = v_line_id;

    v_return_key := 'shop_return:' || v_dispatch.id::text || ':' || v_line_id::text
      || ':' || gen_random_uuid()::text;

    INSERT INTO public.inventory_movements (
      item_id, type, quantity, reason, dispatch_id, location_id, source,
      from_shop_id, performed_by
    )
    VALUES (
      v_item_id, 'stock_out', v_qty,
      COALESCE(NULLIF(btrim(_reason), ''), 'Return from shop') || ' (' || v_dispatch.reference || ')',
      v_dispatch.id, v_dispatch.destination_location_id, v_return_key || ':out',
      v_dispatch.shop_id, auth.uid()
    );

    INSERT INTO public.inventory_movements (
      item_id, type, quantity, reason, dispatch_id, location_id, source,
      from_shop_id, performed_by
    )
    VALUES (
      v_item_id, 'stock_in', v_qty,
      COALESCE(NULLIF(btrim(_reason), ''), 'Return from shop') || ' (' || v_dispatch.reference || ')',
      v_dispatch.id, v_dispatch.source_location_id, v_return_key || ':in',
      v_dispatch.shop_id, auth.uid()
    );
  END LOOP;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(), 'dispatch.return_recorded', 'dispatches', v_dispatch.id::text,
    jsonb_build_object(
      'lines', _lines,
      'reason', _reason,
      'source_location_id', v_dispatch.source_location_id,
      'shop_location_id', v_dispatch.destination_location_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_shop_return(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_shop_return(uuid, jsonb, text) TO authenticated;

-- Repair shop dispatches created during the live test. The reset removed all
-- older operational history, so this date guard targets only the new pilot.
DO $$
DECLARE
  v_source_location_id uuid;
  v_destination_location_id uuid;
  v_dispatch record;
  v_line record;
  v_backfilled integer := 0;
BEGIN
  SELECT id INTO v_source_location_id
  FROM public.locations
  WHERE status = 'active'
    AND (is_default OR lower(name) = 'main store')
  ORDER BY is_default DESC, created_at
  LIMIT 1;

  IF v_source_location_id IS NULL THEN
    RAISE EXCEPTION 'Main Store source location is not configured';
  END IF;

  FOR v_dispatch IN
    SELECT d.*
    FROM public.dispatches d
    WHERE d.shop_id IS NOT NULL
      AND d.replenishment_request_id IS NULL
      AND d.dispatched_at >= timestamptz '2026-08-03 00:00:00+01'
    ORDER BY d.dispatched_at
  LOOP
    SELECT id INTO v_destination_location_id
    FROM public.locations
    WHERE shop_id = v_dispatch.shop_id AND status = 'active'
    ORDER BY created_at
    LIMIT 1;

    IF v_destination_location_id IS NULL THEN
      RAISE EXCEPTION 'No active inventory location exists for shop %', v_dispatch.shop_id;
    END IF;

    UPDATE public.dispatches
    SET source_location_id = COALESCE(source_location_id, v_source_location_id),
        destination_location_id = COALESCE(destination_location_id, v_destination_location_id)
    WHERE id = v_dispatch.id;

    UPDATE public.inventory_movements
    SET location_id = v_source_location_id,
        source = COALESCE(source, 'shop_dispatch_issue_backfill:' || id::text)
    WHERE dispatch_id = v_dispatch.id
      AND type = 'stock_out'
      AND location_id IS NULL;

    IF v_dispatch.status IN ('received', 'reconciled') THEN
      FOR v_line IN
        SELECT * FROM public.dispatch_lines WHERE dispatch_id = v_dispatch.id
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM public.inventory_movements
          WHERE source = 'shop_dispatch_receipt_backfill:' || v_dispatch.id::text || ':' || v_line.id::text
        ) THEN
          INSERT INTO public.inventory_movements (
            item_id, type, quantity, reason, dispatch_id, location_id, source,
            to_shop_id, performed_by, created_at
          )
          VALUES (
            v_line.item_id, 'stock_in', v_line.quantity_dispatched,
            'Backfilled received dispatch ' || v_dispatch.reference,
            v_dispatch.id, v_destination_location_id,
            'shop_dispatch_receipt_backfill:' || v_dispatch.id::text || ':' || v_line.id::text,
            v_dispatch.shop_id, v_dispatch.received_by,
            COALESCE(v_dispatch.received_at, v_dispatch.dispatched_at)
          );
        END IF;
      END LOOP;
    END IF;

    INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
    VALUES (
      NULL, 'system.shop_dispatch_location_backfilled', 'dispatches', v_dispatch.id::text,
      jsonb_build_object(
        'reference', v_dispatch.reference,
        'source_location_id', v_source_location_id,
        'destination_location_id', v_destination_location_id,
        'status', v_dispatch.status
      )
    );
    v_backfilled := v_backfilled + 1;
  END LOOP;

  IF v_backfilled > 0 THEN
    INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
    VALUES (
      NULL, 'system.shop_dispatch_batch_repaired', 'inventory_movements',
      'live-test-2026-08-03', jsonb_build_object('dispatches_repaired', v_backfilled)
    );
  END IF;
END;
$$;

CREATE OR REPLACE VIEW public.v_shop_daily_balance
WITH (security_invoker = true)
AS
WITH opening AS (
  SELECT c.shop_id, c.count_date, line.item_id, line.quantity_counted AS opening_qty,
    c.status AS opening_status, c.id AS opening_id
  FROM public.shop_stock_counts c
  JOIN public.shop_stock_count_lines line ON line.count_id = c.id
  WHERE c.count_type = 'opening'
), closing AS (
  SELECT c.shop_id, c.count_date, line.item_id, line.quantity_counted AS closing_qty,
    c.status AS closing_status, c.id AS closing_id
  FROM public.shop_stock_counts c
  JOIN public.shop_stock_count_lines line ON line.count_id = c.id
  WHERE c.count_type = 'closing'
), recv AS (
  SELECT COALESCE(location.shop_id, movement.to_shop_id) AS shop_id,
    (movement.created_at AT TIME ZONE 'Africa/Lagos')::date AS d,
    movement.item_id,
    sum(abs(movement.quantity)) AS qty
  FROM public.inventory_movements movement
  LEFT JOIN public.locations location ON location.id = movement.location_id
  WHERE COALESCE(location.shop_id, movement.to_shop_id) IS NOT NULL
    AND movement.type IN ('stock_in', 'receipt', 'adjustment_in', 'production_output')
  GROUP BY 1, 2, 3
), ret AS (
  SELECT COALESCE(location.shop_id, movement.from_shop_id) AS shop_id,
    (movement.created_at AT TIME ZONE 'Africa/Lagos')::date AS d,
    movement.item_id,
    sum(abs(movement.quantity)) AS qty
  FROM public.inventory_movements movement
  LEFT JOIN public.locations location ON location.id = movement.location_id
  WHERE COALESCE(location.shop_id, movement.from_shop_id) IS NOT NULL
    AND movement.type = 'stock_out'
  GROUP BY 1, 2, 3
), sold_wasted AS (
  SELECT COALESCE(location.shop_id, movement.from_shop_id) AS shop_id,
    (movement.created_at AT TIME ZONE 'Africa/Lagos')::date AS d,
    movement.item_id,
    sum(CASE WHEN movement.type = 'sale' THEN abs(movement.quantity) ELSE 0 END) AS sold,
    sum(CASE WHEN movement.type IN ('damaged', 'expired', 'wastage', 'adjustment_out')
      THEN abs(movement.quantity) ELSE 0 END) AS wasted
  FROM public.inventory_movements movement
  LEFT JOIN public.locations location ON location.id = movement.location_id
  WHERE COALESCE(location.shop_id, movement.from_shop_id) IS NOT NULL
    AND movement.type IN ('sale', 'damaged', 'expired', 'wastage', 'adjustment_out')
  GROUP BY 1, 2, 3
)
SELECT COALESCE(opening.shop_id, closing.shop_id) AS shop_id,
  COALESCE(opening.count_date, closing.count_date) AS count_date,
  COALESCE(opening.item_id, closing.item_id) AS item_id,
  opening.opening_qty,
  opening.opening_id,
  opening.opening_status,
  COALESCE(recv.qty, 0) AS received,
  COALESCE(ret.qty, 0) AS returned,
  COALESCE(sold_wasted.sold, 0) AS sold,
  COALESCE(sold_wasted.wasted, 0) AS wasted,
  closing.closing_qty AS actual_closing,
  closing.closing_id,
  closing.closing_status,
  COALESCE(opening.opening_qty, 0) + COALESCE(recv.qty, 0) - COALESCE(ret.qty, 0)
    - COALESCE(sold_wasted.sold, 0) - COALESCE(sold_wasted.wasted, 0) AS expected_closing,
  closing.closing_qty - (
    COALESCE(opening.opening_qty, 0) + COALESCE(recv.qty, 0) - COALESCE(ret.qty, 0)
    - COALESCE(sold_wasted.sold, 0) - COALESCE(sold_wasted.wasted, 0)
  ) AS variance,
  assortment.target_level,
  GREATEST(
    COALESCE(assortment.target_level, 0)
      - COALESCE(closing.closing_qty, opening.opening_qty, 0),
    0
  ) AS restock_recommendation
FROM opening
FULL JOIN closing
  ON closing.shop_id = opening.shop_id
 AND closing.count_date = opening.count_date
 AND closing.item_id = opening.item_id
LEFT JOIN recv
  ON recv.shop_id = COALESCE(opening.shop_id, closing.shop_id)
 AND recv.d = COALESCE(opening.count_date, closing.count_date)
 AND recv.item_id = COALESCE(opening.item_id, closing.item_id)
LEFT JOIN ret
  ON ret.shop_id = COALESCE(opening.shop_id, closing.shop_id)
 AND ret.d = COALESCE(opening.count_date, closing.count_date)
 AND ret.item_id = COALESCE(opening.item_id, closing.item_id)
LEFT JOIN sold_wasted
  ON sold_wasted.shop_id = COALESCE(opening.shop_id, closing.shop_id)
 AND sold_wasted.d = COALESCE(opening.count_date, closing.count_date)
 AND sold_wasted.item_id = COALESCE(opening.item_id, closing.item_id)
LEFT JOIN public.shop_assortments assortment
  ON assortment.shop_id = COALESCE(opening.shop_id, closing.shop_id)
 AND assortment.item_id = COALESCE(opening.item_id, closing.item_id);

GRANT SELECT ON public.v_shop_daily_balance TO authenticated;

CREATE OR REPLACE VIEW public.v_daily_dispatch_report
WITH (security_invoker = true)
AS
SELECT
  dispatch.id AS dispatch_id,
  dispatch.reference,
  dispatch.dispatched_at,
  dispatch.received_at,
  dispatch.status,
  CASE WHEN dispatch.shop_id IS NOT NULL THEN 'shop' ELSE 'bulk_client' END AS destination_type,
  COALESCE(shop.name, client.name) AS destination_name,
  dispatch.shop_id,
  dispatch.client_id,
  dispatch.source_location_id,
  dispatch.destination_location_id,
  source_location.name AS source_location,
  destination_location.name AS destination_location,
  line.id AS dispatch_line_id,
  item.id AS item_id,
  item.sku,
  item.name AS item_name,
  item.unit,
  line.quantity_dispatched,
  line.quantity_returned,
  line.quantity_dispatched - line.quantity_returned AS net_quantity,
  COALESCE(dispatcher.full_name, dispatcher.email) AS dispatched_by_name,
  COALESCE(receiver.full_name, receiver.email) AS received_by_name
FROM public.dispatches dispatch
JOIN public.dispatch_lines line ON line.dispatch_id = dispatch.id
JOIN public.inventory_items item ON item.id = line.item_id
LEFT JOIN public.shops shop ON shop.id = dispatch.shop_id
LEFT JOIN public.clients client ON client.id = dispatch.client_id
LEFT JOIN public.locations source_location ON source_location.id = dispatch.source_location_id
LEFT JOIN public.locations destination_location ON destination_location.id = dispatch.destination_location_id
LEFT JOIN public.profiles dispatcher ON dispatcher.id = dispatch.dispatched_by
LEFT JOIN public.profiles receiver ON receiver.id = dispatch.received_by;

GRANT SELECT ON public.v_daily_dispatch_report TO authenticated;

CREATE OR REPLACE VIEW public.v_inventory_movement_report
WITH (security_invoker = true)
AS
SELECT
  movement.id AS movement_id,
  movement.created_at,
  (movement.created_at AT TIME ZONE 'Africa/Lagos')::date AS movement_date,
  movement.type,
  CASE
    WHEN movement.type IN ('stock_in', 'opening_balance', 'receipt', 'adjustment_in', 'production_output')
      THEN abs(movement.quantity)
    WHEN movement.type IN ('stock_out', 'sale', 'damaged', 'expired', 'wastage', 'production_consume', 'adjustment_out')
      THEN -abs(movement.quantity)
    WHEN movement.type = 'adjustment' THEN movement.quantity
    ELSE 0
  END AS signed_quantity,
  CASE
    WHEN movement.type IN ('stock_in', 'opening_balance', 'receipt', 'adjustment_in', 'production_output') THEN 'in'
    WHEN movement.type IN ('stock_out', 'sale', 'damaged', 'expired', 'wastage', 'production_consume', 'adjustment_out') THEN 'out'
    ELSE 'adjustment'
  END AS direction,
  movement.quantity,
  movement.reason,
  movement.source,
  movement.location_id,
  location.name AS location_name,
  item.id AS item_id,
  item.sku,
  item.name AS item_name,
  item.unit,
  dispatch.reference AS dispatch_reference,
  from_shop.name AS from_shop_name,
  to_shop.name AS to_shop_name,
  from_client.name AS from_client_name,
  to_client.name AS to_client_name,
  movement.performed_by,
  COALESCE(performer.full_name, performer.email) AS performed_by_name
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
