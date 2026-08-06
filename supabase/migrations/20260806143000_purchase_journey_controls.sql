-- Clarify purchasing hand-offs, prevent misleading self-approval actions,
-- and expose approved/placed stock separately from physically accepted stock.

CREATE OR REPLACE FUNCTION public.decide_purchase_order(
  _purchase_order_id uuid,
  _approve boolean,
  _reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po public.purchase_orders%ROWTYPE;
  v_threshold numeric;
BEGIN
  SELECT * INTO v_po
  FROM public.purchase_orders
  WHERE id = _purchase_order_id
  FOR UPDATE;

  IF NOT FOUND OR v_po.workflow_status <> 'awaiting_approval' THEN
    RAISE EXCEPTION 'Order is not awaiting approval';
  END IF;

  IF public.has_role(auth.uid(), 'procurement') THEN
    RAISE EXCEPTION 'Procurement cannot approve a purchase order';
  END IF;

  IF v_po.submitted_by = auth.uid() THEN
    RAISE EXCEPTION 'You submitted this order. Another authorised approver must decide it';
  END IF;

  SELECT routine_approval_threshold_naira INTO v_threshold
  FROM public.purchasing_settings
  WHERE id = true;

  IF v_threshold IS NULL THEN
    IF NOT public.has_any_role(
      auth.uid(),
      ARRAY['super_admin','management']::public.app_role[]
    ) THEN
      RAISE EXCEPTION 'MD approval is required until the monetary threshold is configured';
    END IF;
  ELSIF v_po.quoted_total <= v_threshold THEN
    IF NOT public.has_any_role(
      auth.uid(),
      ARRAY['super_admin','management','production']::public.app_role[]
    ) THEN
      RAISE EXCEPTION 'Production Manager or MD approval is required';
    END IF;
  ELSIF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'MD approval is required for this order';
  END IF;

  IF NOT _approve AND COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'Rejection reason is required';
  END IF;

  UPDATE public.purchase_orders
  SET workflow_status = CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,
      approved_by = auth.uid(),
      approved_at = now(),
      rejection_reason = CASE WHEN _approve THEN NULL ELSE btrim(_reason) END,
      updated_at = now()
  WHERE id = _purchase_order_id;

  UPDATE public.purchase_needs
  SET status = CASE WHEN _approve THEN 'ordered' ELSE 'ready' END,
      updated_at = now()
  WHERE id IN (
    SELECT purchase_need_id
    FROM public.purchase_order_items
    WHERE purchase_order_id = _purchase_order_id
      AND purchase_need_id IS NOT NULL
  );

  INSERT INTO public.audit_log(user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(),
    CASE WHEN _approve THEN 'purchase_order.approved' ELSE 'purchase_order.rejected' END,
    'purchase_orders',
    _purchase_order_id::text,
    jsonb_build_object('reason', _reason, 'submitted_by', v_po.submitted_by)
  );

  RETURN _purchase_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.decide_purchase_order(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_purchase_order(uuid, boolean, text) TO authenticated;

-- A delivery must contain at least one physical unit. Zero-quantity receipts
-- create false custody events and can strand an order in the wrong status.
CREATE OR REPLACE FUNCTION public.record_purchase_delivery(
  _purchase_order_id uuid,
  _client_reference_id text,
  _delivery_evidence_path text,
  _notes text,
  _lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po public.purchase_orders%ROWTYPE;
  v_receipt_id uuid;
  v_row jsonb;
  v_line public.purchase_order_items%ROWTYPE;
  v_number text;
  v_delivered numeric;
  v_total_delivered numeric := 0;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager','procurement']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorised to record supplier delivery';
  END IF;

  SELECT id INTO v_receipt_id
  FROM public.purchase_receipts
  WHERE client_reference_id = _client_reference_id;
  IF v_receipt_id IS NOT NULL THEN RETURN v_receipt_id; END IF;

  SELECT * INTO v_po
  FROM public.purchase_orders
  WHERE id = _purchase_order_id
  FOR UPDATE;

  IF NOT FOUND OR v_po.workflow_status NOT IN ('being_purchased','partially_received') THEN
    RAISE EXCEPTION 'Order is not ready for delivery';
  END IF;
  IF COALESCE(btrim(_delivery_evidence_path), '') = ''
     OR _lines IS NULL
     OR jsonb_typeof(_lines) <> 'array'
     OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'Delivery evidence and delivered quantities are required';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO v_line
    FROM public.purchase_order_items
    WHERE id = (v_row ->> 'line_id')::uuid
      AND purchase_order_id = _purchase_order_id
    FOR UPDATE;

    v_delivered := COALESCE((v_row ->> 'delivered')::numeric, 0);
    IF NOT FOUND OR v_delivered < 0
       OR v_line.quantity_delivered + v_delivered > v_line.quantity_ordered THEN
      RAISE EXCEPTION 'Invalid delivered quantity';
    END IF;
    v_total_delivered := v_total_delivered + v_delivered;
  END LOOP;

  IF v_total_delivered <= 0 THEN
    RAISE EXCEPTION 'At least one delivered quantity must be greater than zero';
  END IF;

  v_number := 'REC-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS-US');
  INSERT INTO public.purchase_receipts(
    receipt_number, client_reference_id, purchase_order_id,
    delivery_evidence_path, delivery_notes, recorded_by
  )
  VALUES (
    v_number, _client_reference_id, _purchase_order_id,
    btrim(_delivery_evidence_path), NULLIF(btrim(_notes), ''), auth.uid()
  )
  RETURNING id INTO v_receipt_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_delivered := COALESCE((v_row ->> 'delivered')::numeric, 0);
    IF v_delivered = 0 THEN CONTINUE; END IF;

    SELECT * INTO v_line
    FROM public.purchase_order_items
    WHERE id = (v_row ->> 'line_id')::uuid
      AND purchase_order_id = _purchase_order_id
    FOR UPDATE;

    INSERT INTO public.purchase_receipt_lines(
      purchase_receipt_id, purchase_order_item_id, quantity_delivered
    )
    VALUES (v_receipt_id, v_line.id, v_delivered);

    UPDATE public.purchase_order_items
    SET quantity_delivered = quantity_delivered + v_delivered
    WHERE id = v_line.id;
  END LOOP;

  UPDATE public.purchase_orders
  SET workflow_status = 'delivered', delivered_at = now(), updated_at = now()
  WHERE id = _purchase_order_id;

  INSERT INTO public.audit_log(user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(), 'purchase_order.delivery_recorded', 'purchase_orders',
    _purchase_order_id::text,
    jsonb_build_object(
      'receipt_id', v_receipt_id,
      'total_delivered', v_total_delivered,
      'lines', _lines
    )
  );

  RETURN v_receipt_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_purchase_delivery(uuid, text, text, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_purchase_delivery(uuid, text, text, text, jsonb)
  TO authenticated;

-- Incoming is deliberately separate from on-hand. It begins only after the
-- approved order has been placed and disappears as quantities are accepted.
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
), incoming AS (
  SELECT
    poi.item_id,
    poi.location_id,
    SUM(GREATEST(poi.quantity_ordered - poi.quantity_accepted, 0)) AS incoming_quantity
  FROM public.purchase_order_items poi
  JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
  WHERE po.workflow_status IN ('being_purchased','delivered','partially_received')
  GROUP BY poi.item_id, poi.location_id
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
  COALESCE(stock.on_hand, 0) AS on_hand,
  COALESCE(incoming.incoming_quantity, 0) AS incoming_quantity,
  COALESCE(stock.on_hand, 0) + COALESCE(incoming.incoming_quantity, 0) AS projected_quantity
FROM public.inventory_items ii
CROSS JOIN central
LEFT JOIN public.v_item_location_stock stock
  ON stock.item_id = ii.id
 AND stock.location_id = central.id
LEFT JOIN incoming
  ON incoming.item_id = ii.id
 AND incoming.location_id = central.id;

GRANT SELECT ON public.v_central_item_stock TO authenticated;

INSERT INTO public.audit_log(user_id, action, entity, entity_id, new_value)
VALUES (
  NULL,
  'system.purchase_journey_controls_updated',
  'purchasing_settings',
  'global',
  jsonb_build_object(
    'self_approval_block_explained', true,
    'zero_quantity_deliveries_blocked', true,
    'incoming_stock_separated_from_on_hand', true
  )
);
