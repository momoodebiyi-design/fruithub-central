-- Keep the event clock separate from the immutable entry/audit clock.
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS occurred_at timestamptz;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS client_reference_id text;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_client_reference_uidx
  ON public.inventory_movements(client_reference_id) WHERE client_reference_id IS NOT NULL;
ALTER TABLE public.central_stocktakes
  ADD COLUMN IF NOT EXISTS counted_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_entry_reason text,
  ADD COLUMN IF NOT EXISTS later_count_override_authorised boolean NOT NULL DEFAULT false;
ALTER TABLE public.dispatch_returns
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_entry_reason text;
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS quoted_at timestamptz,
  ADD COLUMN IF NOT EXISTS placed_at timestamptz,
  ADD COLUMN IF NOT EXISTS quote_late_entry_reason text,
  ADD COLUMN IF NOT EXISTS placement_late_entry_reason text;
ALTER TABLE public.purchase_needs
  ADD COLUMN IF NOT EXISTS observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS observation_late_entry_reason text;
ALTER TABLE public.purchase_receipts
  ADD COLUMN IF NOT EXISTS arrived_at timestamptz,
  ADD COLUMN IF NOT EXISTS inspected_effective_at timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_late_entry_reason text,
  ADD COLUMN IF NOT EXISTS inspection_late_entry_reason text;

CREATE INDEX IF NOT EXISTS inventory_movements_location_occurred_idx
  ON public.inventory_movements(location_id,item_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS central_stocktakes_location_counted_idx
  ON public.central_stocktakes(location_id,counted_at DESC)
  WHERE status IN ('posted','approved');
CREATE INDEX IF NOT EXISTS dispatch_returns_returned_idx
  ON public.dispatch_returns(returned_at DESC);

UPDATE public.central_stocktakes SET counted_at=created_at WHERE counted_at IS NULL;
UPDATE public.dispatch_returns SET returned_at=recorded_at WHERE returned_at IS NULL;
UPDATE public.purchase_orders SET quoted_at=created_at WHERE quoted_at IS NULL;
UPDATE public.purchase_needs SET observed_at=created_at WHERE observed_at IS NULL;
UPDATE public.purchase_orders SET placed_at=payment_recorded_at
  WHERE placed_at IS NULL AND payment_recorded_at IS NOT NULL;
UPDATE public.purchase_receipts SET arrived_at=recorded_at WHERE arrived_at IS NULL;
UPDATE public.purchase_receipts SET inspected_effective_at=inspected_at
  WHERE inspected_effective_at IS NULL AND inspected_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_operational_event_time(
  _occurred_at timestamptz, _late_entry_reason text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_late boolean;
BEGIN
  IF _occurred_at IS NULL OR _occurred_at > now()+interval '5 minutes' THEN
    RAISE EXCEPTION 'Select an event date and time that is not in the future';
  END IF;
  v_late := (_occurred_at AT TIME ZONE 'Africa/Lagos')::date
    < (now() AT TIME ZONE 'Africa/Lagos')::date;
  IF v_late THEN
    IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management']::public.app_role[]) THEN
      RAISE EXCEPTION 'Management or Admin must record an earlier-day event';
    END IF;
    IF length(btrim(coalesce(_late_entry_reason,''))) < 5 THEN
      RAISE EXCEPTION 'Explain why this event is being entered late';
    END IF;
  END IF;
  RETURN v_late;
END; $$;

CREATE OR REPLACE FUNCTION public.assert_no_later_central_count(
  _item_id uuid, _location_id uuid, _occurred_at timestamptz,
  _manager_override boolean DEFAULT false, _override_reason text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count_number text;
BEGIN
  SELECT count.count_number INTO v_count_number
  FROM public.central_stocktakes count
  JOIN public.central_stocktake_lines line ON line.stocktake_id=count.id
  WHERE count.location_id=_location_id AND line.item_id=_item_id
    AND count.status IN ('posted','approved')
    AND COALESCE(count.counted_at,count.created_at) >= _occurred_at
  ORDER BY COALESCE(count.counted_at,count.created_at) ASC LIMIT 1;
  IF v_count_number IS NOT NULL THEN
    IF NOT coalesce(_manager_override,false) THEN
      RAISE EXCEPTION 'A later posted Central count (%) covers this item. Management can authorise a reconciliation-only override', v_count_number;
    END IF;
    IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','admin','management']::public.app_role[])
       OR length(btrim(coalesce(_override_reason,'')))<5 THEN
      RAISE EXCEPTION 'Management/Admin and an override reason are required to cross posted count %',v_count_number;
    END IF;
  END IF;
  RETURN v_count_number;
END; $$;

-- The later physical count remains authoritative. A manager's historic entry is
-- visible on its actual date, with an explicit opposite movement now so today's
-- balance is not counted twice. Both writes are in the caller's transaction.
CREATE OR REPLACE FUNCTION public.record_later_count_reconciliation(
  _item_id uuid, _location_id uuid, _delta numeric, _movement_id uuid,
  _count_number text, _override_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_reconciliation_at timestamptz;
BEGIN
  IF _count_number IS NULL OR coalesce(_delta,0)=0 THEN RETURN; END IF;
  SELECT coalesce(counted_at,created_at)+interval '1 microsecond'
    INTO v_reconciliation_at FROM public.central_stocktakes WHERE count_number=_count_number;
  IF v_reconciliation_at IS NULL THEN RAISE EXCEPTION 'Later count could not be found'; END IF;
  INSERT INTO public.inventory_movements(item_id,type,quantity,reason,location_id,source,
    performed_by,occurred_at)
  VALUES(_item_id,'adjustment',-_delta,
    'Manager override: later count '||_count_number||' remains authoritative — '||btrim(_override_reason),
    _location_id,'late_count_reconciliation:'||_movement_id::text,auth.uid(),v_reconciliation_at)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'stock.later_count_manager_override','inventory_movements',v_id::text,
    jsonb_build_object('historical_movement_id',_movement_id,'later_count',_count_number,
      'offset_quantity',-_delta,'reason',btrim(_override_reason),'recorded_at',now()));
END; $$;

-- Ledger balance at the event time; includes prior actual production/dispatch dates.
CREATE OR REPLACE FUNCTION public.stock_on_hand_at(
  _item_id uuid, _location_id uuid, _occurred_at timestamptz
) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT coalesce(sum(CASE
    WHEN m.type IN ('stock_in','opening_balance','receipt','adjustment_in','production_output') THEN abs(m.quantity)
    WHEN m.type IN ('stock_out','sale','damaged','expired','wastage','production_consume','adjustment_out') THEN -abs(m.quantity)
    WHEN m.type='adjustment' THEN m.quantity ELSE 0 END),0)
  FROM public.inventory_movements m
  LEFT JOIN public.dispatches d ON d.id=m.dispatch_id
  LEFT JOIN public.production_batches b ON b.id=m.related_production_batch
  WHERE m.item_id=_item_id AND m.location_id=_location_id
    AND coalesce(m.occurred_at,
      CASE WHEN m.source LIKE 'shop_dispatch_issue:%'
             OR m.source LIKE 'client_dispatch_issue:%'
             OR m.source LIKE 'sales_channel_dispatch_issue:%' THEN d.dispatched_at
           WHEN m.type IN ('production_output','production_consume') THEN b.produced_at
      END,m.created_at) <= _occurred_at;
$$;

CREATE OR REPLACE FUNCTION public.preview_stock_on_hand_at(
  _item_id uuid, _location_id uuid, _occurred_at timestamptz,
  _override_later_count boolean DEFAULT false, _late_entry_reason text DEFAULT NULL
) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to view historical stock'; END IF;
  IF _occurred_at IS NULL OR _occurred_at>now()+interval '5 minutes' THEN
    RAISE EXCEPTION 'Select a valid count date'; END IF;
  PERFORM public.assert_no_later_central_count(_item_id,_location_id,_occurred_at,
    _override_later_count,_late_entry_reason);
  RETURN public.stock_on_hand_at(_item_id,_location_id,_occurred_at);
END; $$;

CREATE OR REPLACE FUNCTION public.record_manual_movement_with_date(
  _item_id uuid, _location_id uuid, _type public.movement_type,
  _quantity numeric, _reason text, _occurred_at timestamptz, _late_entry_reason text,
  _client_reference_id text, _override_later_count boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_late boolean; v_count text; v_delta numeric; v_current numeric;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','admin','management','operations_manager','inventory_officer','production']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to record stock movements'; END IF;
  IF coalesce(btrim(_client_reference_id),'')='' THEN RAISE EXCEPTION 'Client reference is required'; END IF;
  SELECT id INTO v_id FROM public.inventory_movements WHERE client_reference_id=btrim(_client_reference_id);
  IF FOUND THEN RETURN v_id; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.inventory_items WHERE id=_item_id AND status='active')
    OR NOT EXISTS(SELECT 1 FROM public.locations WHERE id=_location_id AND status='active') THEN
    RAISE EXCEPTION 'Choose an active item and stock location'; END IF;
  IF _type NOT IN ('stock_in','stock_out','adjustment','adjustment_in','adjustment_out','damaged','expired','wastage','opening_balance','receipt')
    OR _quantity IS NULL OR _quantity=0 OR (_type<>'adjustment' AND _quantity<0) THEN
    RAISE EXCEPTION 'Choose a valid movement type and nonzero quantity'; END IF;
  v_delta:=CASE WHEN _type='adjustment' THEN _quantity
    WHEN _type IN ('stock_in','opening_balance','receipt','adjustment_in') THEN abs(_quantity)
    ELSE -abs(_quantity) END;
  v_late:=public.validate_operational_event_time(_occurred_at,_late_entry_reason);
  PERFORM pg_advisory_xact_lock(hashtextextended(_item_id::text||':'||_location_id::text,0));
  v_count:=public.assert_no_later_central_count(_item_id,_location_id,_occurred_at,
    _override_later_count,_late_entry_reason);
  IF public.stock_on_hand_at(_item_id,_location_id,_occurred_at)+v_delta<0 THEN
    RAISE EXCEPTION 'Historical stock would become negative at the event time'; END IF;
  SELECT coalesce(on_hand,0) INTO v_current FROM public.v_item_location_stock
    WHERE item_id=_item_id AND location_id=_location_id;
  IF v_count IS NULL AND coalesce(v_current,0)+v_delta<0 THEN
    RAISE EXCEPTION 'Current stock would become negative'; END IF;
  INSERT INTO public.inventory_movements(item_id,type,quantity,reason,location_id,source,
    performed_by,occurred_at,client_reference_id)
  VALUES(_item_id,_type,CASE WHEN _type='adjustment' THEN _quantity ELSE abs(_quantity) END,
    _reason,_location_id,'manual',auth.uid(),_occurred_at,btrim(_client_reference_id))
  RETURNING id INTO v_id;
  PERFORM public.record_later_count_reconciliation(_item_id,_location_id,v_delta,v_id,
    v_count,_late_entry_reason);
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'movement.actual_date_recorded','inventory_movements',v_id::text,
    jsonb_build_object('occurred_at',_occurred_at,'recorded_at',now(),'late_entry_reason',
      CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END,
      'later_count_override',v_count));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.record_location_stock_count_with_date(
  _item_id uuid, _location_id uuid, _physical_qty numeric, _reason text,
  _occurred_at timestamptz, _late_entry_reason text, _client_reference_id text,
  _override_later_count boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_expected numeric; v_delta numeric; v_late boolean; v_count text; v_current numeric;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to record stock counts'; END IF;
  IF coalesce(btrim(_client_reference_id),'')='' THEN RAISE EXCEPTION 'Client reference is required'; END IF;
  SELECT id INTO v_id FROM public.inventory_movements WHERE client_reference_id=btrim(_client_reference_id);
  IF FOUND THEN RETURN v_id; END IF;
  IF _physical_qty IS NULL OR _physical_qty<0 OR coalesce(btrim(_reason),'')='' THEN
    RAISE EXCEPTION 'Physical quantity and reason are required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.inventory_items WHERE id=_item_id AND status='active')
    OR NOT EXISTS(SELECT 1 FROM public.locations WHERE id=_location_id AND status='active') THEN
    RAISE EXCEPTION 'Choose an active item and stock location'; END IF;
  v_late:=public.validate_operational_event_time(_occurred_at,_late_entry_reason);
  PERFORM pg_advisory_xact_lock(hashtextextended(_item_id::text||':'||_location_id::text,0));
  v_count:=public.assert_no_later_central_count(_item_id,_location_id,_occurred_at,
    _override_later_count,_late_entry_reason);
  v_expected:=public.stock_on_hand_at(_item_id,_location_id,_occurred_at);
  IF v_expected<0 THEN RAISE EXCEPTION 'Historical stock is negative; reconcile first'; END IF;
  v_delta:=_physical_qty-v_expected;
  IF v_delta=0 THEN
    INSERT INTO public.inventory_movements(item_id,type,quantity,reason,location_id,source,
      performed_by,occurred_at,client_reference_id)
    VALUES(_item_id,'adjustment',0,'Stock count: no variance — '||_reason,_location_id,
      'stock_count',auth.uid(),_occurred_at,btrim(_client_reference_id)) RETURNING id INTO v_id;
    INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
    VALUES(auth.uid(),'stock_count.no_variance','inventory_movements',v_id::text,
      jsonb_build_object('location_id',_location_id,'occurred_at',_occurred_at,'physical_qty',_physical_qty,
        'reason',_reason,'later_count_override',v_count));
    RETURN v_id;
  END IF;
  SELECT coalesce(on_hand,0) INTO v_current FROM public.v_item_location_stock
    WHERE item_id=_item_id AND location_id=_location_id;
  IF v_count IS NULL AND coalesce(v_current,0)+v_delta<0 THEN
    RAISE EXCEPTION 'Current stock would become negative'; END IF;
  INSERT INTO public.inventory_movements(item_id,type,quantity,reason,location_id,source,
    performed_by,occurred_at,client_reference_id)
  VALUES(_item_id,'adjustment',v_delta,
    'Stock count: physical '||_physical_qty||' vs historical system '||v_expected||' — '||_reason,
    _location_id,'stock_count',auth.uid(),_occurred_at,btrim(_client_reference_id))
  RETURNING id INTO v_id;
  PERFORM public.record_later_count_reconciliation(_item_id,_location_id,v_delta,v_id,
    v_count,_late_entry_reason);
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'stock_count.actual_date_recorded','inventory_movements',v_id::text,
    jsonb_build_object('occurred_at',_occurred_at,'recorded_at',now(),'late_entry_reason',
      CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END,'expected_at_count',v_expected,
      'later_count_override',v_count));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.record_factory_return_with_date(
  _dispatch_id uuid, _client_reference_id text, _lines jsonb, _reason text,
  _condition_notes text, _returned_at timestamptz, _late_entry_reason text,
  _override_later_count boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_dispatch public.dispatches%ROWTYPE; v_line jsonb; v_item uuid;
  v_late boolean; v_count text; v_move record;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to record factory returns'; END IF;
  SELECT id INTO v_id FROM public.dispatch_returns WHERE client_reference_id=btrim(_client_reference_id);
  IF FOUND THEN RETURN v_id; END IF;
  v_late:=public.validate_operational_event_time(_returned_at,_late_entry_reason);
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id=_dispatch_id;
  IF NOT FOUND OR _returned_at<v_dispatch.dispatched_at THEN
    RAISE EXCEPTION 'Return date must be on or after dispatch'; END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    IF coalesce((v_line->>'quantity_accepted')::numeric,0)>0 THEN
      SELECT item_id INTO v_item FROM public.dispatch_lines WHERE id=(v_line->>'line_id')::uuid AND dispatch_id=_dispatch_id;
      PERFORM public.assert_no_later_central_count(v_item,v_dispatch.source_location_id,
        _returned_at,_override_later_count,_late_entry_reason);
    END IF;
  END LOOP;
  v_id:=public.record_factory_return(_dispatch_id,_client_reference_id,_lines,_reason,_condition_notes);
  UPDATE public.dispatch_returns SET returned_at=_returned_at,
    late_entry_reason=CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END WHERE id=v_id;
  UPDATE public.inventory_movements SET occurred_at=_returned_at
    WHERE source LIKE 'factory_return:'||v_id::text||':%';
  FOR v_move IN SELECT id,item_id,location_id,quantity FROM public.inventory_movements
    WHERE source LIKE 'factory_return:'||v_id::text||':%' LOOP
    v_count:=public.assert_no_later_central_count(v_move.item_id,v_move.location_id,
      _returned_at,_override_later_count,_late_entry_reason);
    PERFORM public.record_later_count_reconciliation(v_move.item_id,v_move.location_id,
      v_move.quantity,v_move.id,v_count,_late_entry_reason);
  END LOOP;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'dispatch.factory_return_actual_date','dispatch_returns',v_id::text,
    jsonb_build_object('returned_at',_returned_at,'recorded_at',now(),'late_entry_reason',
      CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END));
  RETURN v_id;
END; $$;

REVOKE ALL ON FUNCTION public.validate_operational_event_time(timestamptz,text),
  public.assert_no_later_central_count(uuid,uuid,timestamptz,boolean,text),
  public.record_later_count_reconciliation(uuid,uuid,numeric,uuid,text,text),
  public.stock_on_hand_at(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.preview_stock_on_hand_at(uuid,uuid,timestamptz,boolean,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.preview_stock_on_hand_at(uuid,uuid,timestamptz,boolean,text) TO authenticated;
REVOKE ALL ON FUNCTION public.record_manual_movement_with_date(uuid,uuid,public.movement_type,numeric,text,timestamptz,text,text,boolean),
  public.record_location_stock_count_with_date(uuid,uuid,numeric,text,timestamptz,text,text,boolean),
  public.record_factory_return_with_date(uuid,text,jsonb,text,text,timestamptz,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_manual_movement_with_date(uuid,uuid,public.movement_type,numeric,text,timestamptz,text,text,boolean),
  public.record_location_stock_count_with_date(uuid,uuid,numeric,text,timestamptz,text,text,boolean),
  public.record_factory_return_with_date(uuid,text,jsonb,text,text,timestamptz,text,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_quoted_purchase_order_with_date(
  _client_reference_id text, _supplier_id uuid, _expected_date date,
  _quotation_reference text, _quotation_evidence_path text, _notes text, _lines jsonb,
  _quoted_at timestamptz, _late_entry_reason text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_late boolean;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','procurement']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to source purchases'; END IF;
  SELECT id INTO v_id FROM public.purchase_orders WHERE client_reference_id=_client_reference_id;
  IF FOUND THEN RETURN v_id; END IF;
  v_late:=public.validate_operational_event_time(_quoted_at,_late_entry_reason);
  v_id:=public.create_quoted_purchase_order(_client_reference_id,_supplier_id,_expected_date,
    _quotation_reference,_quotation_evidence_path,_notes,_lines);
  UPDATE public.purchase_orders SET quoted_at=_quoted_at,
    quote_late_entry_reason=CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END WHERE id=v_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'purchase_order.quote_actual_date','purchase_orders',v_id::text,
    jsonb_build_object('quoted_at',_quoted_at,'recorded_at',now(),'late_entry_reason',
      CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.create_manual_purchase_need_with_date(
  _client_reference_id text, _item_id uuid, _location_id uuid, _quantity numeric,
  _required_date date, _priority text, _reason text,
  _observed_at timestamptz, _late_entry_reason text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_late boolean;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Only Inventory may create a manual purchase need'; END IF;
  SELECT id INTO v_id FROM public.purchase_needs WHERE client_reference_id=_client_reference_id;
  IF FOUND THEN RETURN v_id; END IF;
  v_late:=public.validate_operational_event_time(_observed_at,_late_entry_reason);
  v_id:=public.create_manual_purchase_need(_client_reference_id,_item_id,_location_id,
    _quantity,_required_date,_priority,_reason);
  UPDATE public.purchase_needs SET observed_at=_observed_at,
    observation_late_entry_reason=CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END WHERE id=v_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'purchase_need.observation_actual_date','purchase_needs',v_id::text,
    jsonb_build_object('observed_at',_observed_at,'recorded_at',now(),'late_entry_reason',
      CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.record_purchase_payment_with_date(
  _purchase_order_id uuid, _payment_reference text, _payment_evidence_path text,
  _placed_at timestamptz, _late_entry_reason text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_late boolean; v_recorded_at timestamptz;
  v_reference text; v_placed_at timestamptz; v_quoted_at timestamptz;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','procurement']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to place orders'; END IF;
  SELECT payment_recorded_at,payment_reference,placed_at,quoted_at
    INTO v_recorded_at,v_reference,v_placed_at,v_quoted_at
    FROM public.purchase_orders WHERE id=_purchase_order_id;
  IF v_recorded_at IS NOT NULL THEN
    IF v_reference=_payment_reference AND v_placed_at=_placed_at THEN RETURN _purchase_order_id; END IF;
    RAISE EXCEPTION 'Order placement is already recorded with different details';
  END IF;
  v_late:=public.validate_operational_event_time(_placed_at,_late_entry_reason);
  IF v_quoted_at IS NOT NULL AND _placed_at<v_quoted_at THEN
    RAISE EXCEPTION 'Order placement cannot precede the supplier quote'; END IF;
  v_id:=public.record_purchase_payment(_purchase_order_id,_payment_reference,_payment_evidence_path);
  UPDATE public.purchase_orders SET placed_at=_placed_at,
    placement_late_entry_reason=CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END WHERE id=v_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'purchase_order.placement_actual_date','purchase_orders',v_id::text,
    jsonb_build_object('placed_at',_placed_at,'recorded_at',now(),'late_entry_reason',
      CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.record_purchase_delivery_with_date(
  _purchase_order_id uuid, _client_reference_id text, _delivery_evidence_path text,
  _notes text, _lines jsonb, _arrived_at timestamptz, _late_entry_reason text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_late boolean; v_placed_at timestamptz;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','procurement']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to record supplier delivery'; END IF;
  SELECT id INTO v_id FROM public.purchase_receipts WHERE client_reference_id=_client_reference_id;
  IF FOUND THEN RETURN v_id; END IF;
  v_late:=public.validate_operational_event_time(_arrived_at,_late_entry_reason);
  SELECT placed_at INTO v_placed_at FROM public.purchase_orders WHERE id=_purchase_order_id;
  IF v_placed_at IS NOT NULL AND _arrived_at<v_placed_at THEN
    RAISE EXCEPTION 'Supplier delivery cannot precede order placement'; END IF;
  v_id:=public.record_purchase_delivery(_purchase_order_id,_client_reference_id,
    _delivery_evidence_path,_notes,_lines);
  UPDATE public.purchase_receipts SET arrived_at=_arrived_at,
    arrival_late_entry_reason=CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END WHERE id=v_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'purchase_receipt.arrival_actual_date','purchase_receipts',v_id::text,
    jsonb_build_object('arrived_at',_arrived_at,'recorded_at',now(),'late_entry_reason',
      CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.inspect_purchase_receipt_with_date(
  _purchase_receipt_id uuid, _client_reference_id text, _quality_notes text,
  _lines jsonb, _inspected_at timestamptz, _late_entry_reason text,
  _override_later_count boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_late boolean; v_receipt public.purchase_receipts%ROWTYPE;
  v_line jsonb; v_item uuid; v_location uuid; v_count text; v_move record;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Only Inventory may inspect purchases'; END IF;
  SELECT * INTO v_receipt FROM public.purchase_receipts WHERE id=_purchase_receipt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  IF v_receipt.status='inspected' THEN RETURN v_receipt.id; END IF;
  v_late:=public.validate_operational_event_time(_inspected_at,_late_entry_reason);
  IF v_receipt.arrived_at IS NOT NULL AND _inspected_at<v_receipt.arrived_at THEN
    RAISE EXCEPTION 'Inspection cannot precede supplier delivery'; END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    IF coalesce((v_line->>'accepted')::numeric,0)>0 THEN
      SELECT item.id, order_line.location_id INTO v_item,v_location
      FROM public.purchase_receipt_lines receipt_line
      JOIN public.purchase_order_items order_line ON order_line.id=receipt_line.purchase_order_item_id
      JOIN public.inventory_items item ON item.id=order_line.item_id
      WHERE receipt_line.id=(v_line->>'receipt_line_id')::uuid
        AND receipt_line.purchase_receipt_id=_purchase_receipt_id;
      PERFORM public.assert_no_later_central_count(v_item,v_location,_inspected_at,
        _override_later_count,_late_entry_reason);
    END IF;
  END LOOP;
  v_id:=public.inspect_purchase_receipt(_purchase_receipt_id,_client_reference_id,_quality_notes,_lines);
  UPDATE public.purchase_receipts SET inspected_effective_at=_inspected_at,
    inspection_late_entry_reason=CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END WHERE id=v_id;
  UPDATE public.inventory_movements SET occurred_at=_inspected_at
    WHERE source LIKE 'purchase_receipt:'||v_id::text||':%';
  FOR v_move IN SELECT id,item_id,location_id,quantity FROM public.inventory_movements
    WHERE source LIKE 'purchase_receipt:'||v_id::text||':%' LOOP
    v_count:=public.assert_no_later_central_count(v_move.item_id,v_move.location_id,
      _inspected_at,_override_later_count,_late_entry_reason);
    PERFORM public.record_later_count_reconciliation(v_move.item_id,v_move.location_id,
      v_move.quantity,v_move.id,v_count,_late_entry_reason);
  END LOOP;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'purchase_receipt.inspection_actual_date','purchase_receipts',v_id::text,
    jsonb_build_object('inspected_at',_inspected_at,'recorded_at',now(),'late_entry_reason',
      CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END));
  RETURN v_id;
END; $$;

REVOKE ALL ON FUNCTION public.create_quoted_purchase_order_with_date(text,uuid,date,text,text,text,jsonb,timestamptz,text),
  public.create_manual_purchase_need_with_date(text,uuid,uuid,numeric,date,text,text,timestamptz,text),
  public.record_purchase_payment_with_date(uuid,text,text,timestamptz,text),
  public.record_purchase_delivery_with_date(uuid,text,text,text,jsonb,timestamptz,text),
  public.inspect_purchase_receipt_with_date(uuid,text,text,jsonb,timestamptz,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_quoted_purchase_order_with_date(text,uuid,date,text,text,text,jsonb,timestamptz,text),
  public.create_manual_purchase_need_with_date(text,uuid,uuid,numeric,date,text,text,timestamptz,text),
  public.record_purchase_payment_with_date(uuid,text,text,timestamptz,text),
  public.record_purchase_delivery_with_date(uuid,text,text,text,jsonb,timestamptz,text),
  public.inspect_purchase_receipt_with_date(uuid,text,text,jsonb,timestamptz,text,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_central_stocktake_with_date(
  _scope text, _notes text, _client_reference_id text,
  _counted_at timestamptz, _late_entry_reason text,
  _override_later_count boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_late boolean; v_header public.central_stocktakes%ROWTYPE;
  v_line record; v_expected numeric;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to start a Central stocktake'; END IF;
  SELECT id INTO v_id FROM public.central_stocktakes WHERE client_reference_id=_client_reference_id;
  IF FOUND THEN RETURN v_id; END IF;
  v_late:=public.validate_operational_event_time(_counted_at,_late_entry_reason);
  v_id:=public.create_central_stocktake(_scope,_notes,_client_reference_id);
  SELECT * INTO v_header FROM public.central_stocktakes WHERE id=v_id;
  FOR v_line IN SELECT item_id FROM public.central_stocktake_lines WHERE stocktake_id=v_id LOOP
    PERFORM public.assert_no_later_central_count(v_line.item_id,v_header.location_id,
      _counted_at,_override_later_count,_late_entry_reason);
    v_expected:=public.stock_on_hand_at(v_line.item_id,v_header.location_id,_counted_at);
    IF v_expected<0 THEN RAISE EXCEPTION 'Historical balance is negative for item %; reconcile before counting',v_line.item_id; END IF;
    UPDATE public.central_stocktake_lines SET expected_quantity=v_expected
      WHERE stocktake_id=v_id AND item_id=v_line.item_id;
  END LOOP;
  UPDATE public.central_stocktakes SET counted_at=_counted_at,
    late_entry_reason=CASE WHEN v_late OR _override_later_count THEN btrim(_late_entry_reason) ELSE NULL END,
    later_count_override_authorised=coalesce(_override_later_count,false) WHERE id=v_id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'central_stocktake.actual_date_recorded','central_stocktakes',v_id::text,
    jsonb_build_object('counted_at',_counted_at,'recorded_at',now(),'late_entry_reason',
      CASE WHEN v_late THEN btrim(_late_entry_reason) ELSE NULL END));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.refresh_central_stocktake_expected(_stocktake_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_header public.central_stocktakes%ROWTYPE; v_line record; v_expected numeric;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to refresh a stocktake'; END IF;
  SELECT * INTO v_header FROM public.central_stocktakes WHERE id=_stocktake_id FOR UPDATE;
  IF NOT FOUND OR v_header.status<>'draft' THEN RAISE EXCEPTION 'Only a draft stocktake can be refreshed'; END IF;
  FOR v_line IN SELECT item_id FROM public.central_stocktake_lines WHERE stocktake_id=_stocktake_id LOOP
    PERFORM public.assert_no_later_central_count(v_line.item_id,v_header.location_id,
      v_header.counted_at,v_header.later_count_override_authorised,v_header.late_entry_reason);
    v_expected:=public.stock_on_hand_at(v_line.item_id,v_header.location_id,v_header.counted_at);
    IF v_expected<0 THEN RAISE EXCEPTION 'Historical balance is negative for item %',v_line.item_id; END IF;
    UPDATE public.central_stocktake_lines SET expected_quantity=v_expected
      WHERE stocktake_id=_stocktake_id AND item_id=v_line.item_id;
  END LOOP;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'central_stocktake.expected_refreshed','central_stocktakes',_stocktake_id::text,
    jsonb_build_object('counted_at',v_header.counted_at));
END; $$;

CREATE OR REPLACE FUNCTION public.submit_central_stocktake_with_date(_stocktake_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_header public.central_stocktakes%ROWTYPE; v_line record; v_expected numeric;
  v_current numeric; v_count text; v_move record;
BEGIN
  IF NOT public.has_any_role(auth.uid(),ARRAY['super_admin','admin','management','operations_manager','inventory_officer']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to post a Central stocktake'; END IF;
  SELECT * INTO v_header FROM public.central_stocktakes WHERE id=_stocktake_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake not found'; END IF;
  IF v_header.status='posted' THEN RETURN; END IF;
  IF v_header.counted_at IS NULL THEN RAISE EXCEPTION 'Stocktake count date is missing'; END IF;
  FOR v_line IN SELECT * FROM public.central_stocktake_lines WHERE stocktake_id=_stocktake_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_line.item_id::text||':'||v_header.location_id::text,0));
    v_count:=public.assert_no_later_central_count(v_line.item_id,v_header.location_id,
      v_header.counted_at,v_header.later_count_override_authorised,v_header.late_entry_reason);
    v_expected:=public.stock_on_hand_at(v_line.item_id,v_header.location_id,v_header.counted_at);
    IF v_line.expected_quantity<>v_expected THEN
      RAISE EXCEPTION 'Ledger changed since this count was started. Refresh expected stock and review variances before posting';
    END IF;
    SELECT coalesce(on_hand,0) INTO v_current FROM public.v_item_location_stock
      WHERE item_id=v_line.item_id AND location_id=v_header.location_id;
    IF v_count IS NULL AND coalesce(v_current,0)+coalesce(v_line.counted_quantity-v_line.expected_quantity,0)<0 THEN
      RAISE EXCEPTION 'Posting this historical count would make current stock negative. Reconcile item % first',v_line.item_id;
    END IF;
  END LOOP;
  PERFORM public.submit_central_stocktake(_stocktake_id);
  UPDATE public.inventory_movements SET occurred_at=v_header.counted_at
    WHERE source LIKE 'central_stocktake:'||_stocktake_id::text||':%';
  FOR v_move IN SELECT id,item_id,location_id,
    CASE WHEN type='adjustment_in' THEN quantity ELSE -quantity END AS delta
    FROM public.inventory_movements
    WHERE source LIKE 'central_stocktake:'||_stocktake_id::text||':%' LOOP
    v_count:=public.assert_no_later_central_count(v_move.item_id,v_move.location_id,
      v_header.counted_at,v_header.later_count_override_authorised,v_header.late_entry_reason);
    PERFORM public.record_later_count_reconciliation(v_move.item_id,v_move.location_id,
      v_move.delta,v_move.id,v_count,v_header.late_entry_reason);
  END LOOP;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value)
  VALUES(auth.uid(),'central_stocktake.posted_with_actual_date','central_stocktakes',_stocktake_id::text,
    jsonb_build_object('counted_at',v_header.counted_at,'posted_at',now()));
END; $$;

REVOKE ALL ON FUNCTION public.create_central_stocktake_with_date(text,text,text,timestamptz,text,boolean),
  public.refresh_central_stocktake_expected(uuid),
  public.submit_central_stocktake_with_date(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_central_stocktake_with_date(text,text,text,timestamptz,text,boolean),
  public.refresh_central_stocktake_expected(uuid),
  public.submit_central_stocktake_with_date(uuid) TO authenticated;

CREATE OR REPLACE VIEW public.v_inventory_movement_report
WITH (security_invoker = true) AS
SELECT
  movement.id AS movement_id,
  movement.created_at,
  (coalesce(movement.occurred_at,
    CASE WHEN movement.source LIKE 'shop_dispatch_issue:%'
           OR movement.source LIKE 'client_dispatch_issue:%'
           OR movement.source LIKE 'sales_channel_dispatch_issue:%' THEN dispatch.dispatched_at
         WHEN movement.type IN ('production_output','production_consume') THEN batch.produced_at
    END,movement.created_at) AT TIME ZONE 'Africa/Lagos')::date AS movement_date,
  movement.type,
  CASE
    WHEN movement.type IN ('stock_in','opening_balance','receipt','adjustment_in','production_output') THEN abs(movement.quantity)
    WHEN movement.type IN ('stock_out','sale','damaged','expired','wastage','production_consume','adjustment_out') THEN -abs(movement.quantity)
    WHEN movement.type='adjustment' THEN movement.quantity ELSE 0 END AS signed_quantity,
  CASE
    WHEN movement.type IN ('stock_in','opening_balance','receipt','adjustment_in','production_output') THEN 'in'
    WHEN movement.type IN ('stock_out','sale','damaged','expired','wastage','production_consume','adjustment_out') THEN 'out'
    ELSE 'adjustment' END AS direction,
  movement.quantity, movement.reason, movement.source, movement.location_id,
  location.name AS location_name,
  item.id AS item_id, item.sku, item.name AS item_name, item.unit,
  dispatch.reference AS dispatch_reference,
  from_shop.name AS from_shop_name, to_shop.name AS to_shop_name,
  from_client.name AS from_client_name, to_client.name AS to_client_name,
  movement.performed_by,
  coalesce(performer.full_name,performer.email) AS performed_by_name,
  coalesce(movement.occurred_at,
    CASE WHEN movement.source LIKE 'shop_dispatch_issue:%'
           OR movement.source LIKE 'client_dispatch_issue:%'
           OR movement.source LIKE 'sales_channel_dispatch_issue:%' THEN dispatch.dispatched_at
         WHEN movement.type IN ('production_output','production_consume') THEN batch.produced_at
    END,movement.created_at) AS occurred_at,
  (coalesce(movement.occurred_at,
    CASE WHEN movement.source LIKE 'shop_dispatch_issue:%'
           OR movement.source LIKE 'client_dispatch_issue:%'
           OR movement.source LIKE 'sales_channel_dispatch_issue:%' THEN dispatch.dispatched_at
         WHEN movement.type IN ('production_output','production_consume') THEN batch.produced_at
    END,movement.created_at) AT TIME ZONE 'Africa/Lagos')::date
    < (movement.created_at AT TIME ZONE 'Africa/Lagos')::date AS entered_late,
  channel.name AS sales_channel_name,
  dispatch.charge_mode AS dispatch_charge_mode
FROM public.inventory_movements movement
JOIN public.inventory_items item ON item.id=movement.item_id
LEFT JOIN public.locations location ON location.id=movement.location_id
LEFT JOIN public.dispatches dispatch ON dispatch.id=movement.dispatch_id
LEFT JOIN public.sales_channels channel ON channel.id=dispatch.sales_channel_id
LEFT JOIN public.production_batches batch ON batch.id=movement.related_production_batch
LEFT JOIN public.shops from_shop ON from_shop.id=movement.from_shop_id
LEFT JOIN public.shops to_shop ON to_shop.id=movement.to_shop_id
LEFT JOIN public.clients from_client ON from_client.id=movement.from_client_id
LEFT JOIN public.clients to_client ON to_client.id=movement.to_client_id
LEFT JOIN public.profiles performer ON performer.id=movement.performed_by;

CREATE OR REPLACE VIEW public.v_dispatch_return_report
WITH (security_invoker = true) AS
SELECT returned.id AS return_id, returned.return_number, returned.recorded_at,
  returned.reason, returned.condition_notes, returned.dispatch_id,
  dispatch.reference AS dispatch_reference, dispatch.dispatched_at,
  dispatch.shop_id, shop.name AS shop_name, dispatch.source_location_id,
  source_location.name AS source_location, line.id AS return_line_id,
  line.item_id, item.sku, item.name AS item_name, item.unit,
  line.quantity_returned, line.quantity_accepted, line.quantity_rejected,
  returned.recorded_by, coalesce(recorder.full_name,recorder.email) AS recorded_by_name,
  CASE WHEN dispatch.shop_id IS NOT NULL THEN 'shop' ELSE 'sales_channel' END AS destination_type,
  coalesce(shop.name,channel.name) AS destination_name,
  coalesce(returned.returned_at,returned.recorded_at) AS returned_at,
  returned.late_entry_reason
FROM public.dispatch_returns returned
JOIN public.dispatch_return_lines line ON line.return_id=returned.id
JOIN public.dispatches dispatch ON dispatch.id=returned.dispatch_id
JOIN public.inventory_items item ON item.id=line.item_id
LEFT JOIN public.shops shop ON shop.id=dispatch.shop_id
LEFT JOIN public.sales_channels channel ON channel.id=dispatch.sales_channel_id
LEFT JOIN public.locations source_location ON source_location.id=dispatch.source_location_id
LEFT JOIN public.profiles recorder ON recorder.id=returned.recorded_by;

GRANT SELECT ON public.v_inventory_movement_report,public.v_dispatch_return_report TO authenticated;
NOTIFY pgrst,'reload schema';
