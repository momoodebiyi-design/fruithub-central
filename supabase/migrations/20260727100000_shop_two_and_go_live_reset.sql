-- Add Shop 2 to location-aware replenishment and prepare a guarded clean-start
-- operation for the 27 July 2026 live pilot. The reset function is service-only
-- and does nothing until it is explicitly called with the confirmation phrase.

DO $$
DECLARE
  v_shop_id uuid;
  v_location_id uuid;
BEGIN
  SELECT id INTO v_shop_id
  FROM public.shops
  WHERE lower(name) = 'shop 2'
  LIMIT 1;

  IF v_shop_id IS NOT NULL THEN
    SELECT id INTO v_location_id
    FROM public.locations
    WHERE shop_id = v_shop_id OR lower(name) = 'shop 2'
    ORDER BY (shop_id = v_shop_id) DESC
    LIMIT 1;

    IF v_location_id IS NULL THEN
      INSERT INTO public.locations (
        location_id, name, location_type, is_default, status, shop_id, notes
      ) VALUES (
        'LOC0003', 'Shop 2', 'shop', false, 'active', v_shop_id,
        'Shop stock location added for the live replenishment pilot'
      );
    ELSE
      UPDATE public.locations
      SET shop_id = v_shop_id,
          name = 'Shop 2',
          location_type = 'shop',
          status = 'active',
          updated_at = now()
      WHERE id = v_location_id;
    END IF;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.go_live_reset_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reset_key text NOT NULL UNIQUE,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.go_live_reset_archives ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.go_live_reset_archives FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.go_live_reset_archives TO service_role;

CREATE OR REPLACE FUNCTION public.perform_go_live_reset(_confirmation text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reset_key constant text := 'live-pilot-2026-07-27';
  v_archive_id uuid;
  v_main_store_id uuid;
  v_inserted integer := 0;
  v_result jsonb;
BEGIN
  IF _confirmation <> 'RESET PRELIVE TRANSACTIONS AND LOAD 2026-07-27 COUNT' THEN
    RAISE EXCEPTION 'The exact go-live reset confirmation phrase is required';
  END IF;

  SELECT id INTO v_archive_id
  FROM public.go_live_reset_archives
  WHERE reset_key = v_reset_key;

  IF v_archive_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_completed',
      'reset_key', v_reset_key,
      'archive_id', v_archive_id
    );
  END IF;

  SELECT id INTO v_main_store_id
  FROM public.locations
  WHERE is_default OR lower(name) = 'main store'
  ORDER BY is_default DESC
  LIMIT 1;

  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Main Store location is not configured';
  END IF;

  INSERT INTO public.go_live_reset_archives (reset_key, snapshot)
  VALUES (
    v_reset_key,
    jsonb_build_object(
      'captured_at', now(),
      'inventory_movements', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.inventory_movements t), '[]'::jsonb),
      'inventory_batches', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.inventory_batches t), '[]'::jsonb),
      'production_batches', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.production_batches t), '[]'::jsonb),
      'production_consumption', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.production_consumption t), '[]'::jsonb),
      'stock_requests', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.stock_requests t), '[]'::jsonb),
      'dispatches', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.dispatches t), '[]'::jsonb),
      'dispatch_lines', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.dispatch_lines t), '[]'::jsonb),
      'shop_stock_counts', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.shop_stock_counts t), '[]'::jsonb),
      'shop_stock_count_lines', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.shop_stock_count_lines t), '[]'::jsonb),
      'sales_orders', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.sales_orders t), '[]'::jsonb),
      'sales_order_items', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.sales_order_items t), '[]'::jsonb),
      'purchase_needs', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.purchase_needs t), '[]'::jsonb),
      'purchase_orders', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.purchase_orders t), '[]'::jsonb),
      'purchase_order_items', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.purchase_order_items t), '[]'::jsonb),
      'purchase_receipts', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.purchase_receipts t), '[]'::jsonb),
      'purchase_receipt_lines', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.purchase_receipt_lines t), '[]'::jsonb),
      'purchase_discrepancies', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.purchase_discrepancies t), '[]'::jsonb),
      'replenishment_discrepancies', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.replenishment_discrepancies t), '[]'::jsonb),
      'notifications', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.notifications t), '[]'::jsonb),
      'audit_log', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.audit_log t), '[]'::jsonb),
      'legacy_item_quantities', COALESCE((SELECT jsonb_agg(jsonb_build_object('item_id', id, 'quantity', quantity)) FROM public.inventory_items WHERE quantity <> 0), '[]'::jsonb)
    )
  )
  RETURNING id INTO v_archive_id;

  -- Break the two nullable dispatch/request links before deleting test history.
  UPDATE public.stock_requests
  SET dispatch_id = NULL,
      fulfilled_movement_id = NULL;
  UPDATE public.dispatches
  SET replenishment_request_id = NULL;

  DELETE FROM public.purchase_discrepancies;
  DELETE FROM public.purchase_receipt_lines;
  DELETE FROM public.purchase_receipts;
  DELETE FROM public.purchase_order_items;
  DELETE FROM public.purchase_orders;
  DELETE FROM public.replenishment_discrepancies;
  DELETE FROM public.dispatch_lines;
  DELETE FROM public.inventory_movements;
  DELETE FROM public.dispatches;
  DELETE FROM public.stock_requests;
  DELETE FROM public.purchase_needs;
  DELETE FROM public.shop_stock_count_lines;
  DELETE FROM public.shop_stock_counts;
  DELETE FROM public.production_consumption;
  DELETE FROM public.production_batches;
  DELETE FROM public.inventory_batches;
  DELETE FROM public.sales_order_items;
  DELETE FROM public.sales_orders;
  DELETE FROM public.notifications;
  DELETE FROM public.audit_log;

  UPDATE public.inventory_items
  SET quantity = 0,
      updated_at = now();

  PERFORM setval('public.purchase_need_number_seq', 1, false);

  -- The photographed yellow Stock Count column is authoritative. All active
  -- items not listed here remain at the confirmed opening quantity of zero.
  WITH opening_counts(sku, quantity) AS (
    VALUES
      ('FG-ORANGE-JUICE', 6::numeric),
      ('FG-PINEAPPL-JUICE', 9::numeric),
      ('FG-PINEAPPL-ORANGE', 39::numeric),
      ('FG-PINEAPPL-LEMON', 20::numeric),
      ('FG-PINEAPPL-CARROT', 32::numeric),
      ('FG-WATERMEL-MIX', 28::numeric),
      ('FG-CUCUMBER-BLISS', 28::numeric),
      ('FG-TIGERNUT', 233::numeric),
      ('FG-BEET-BLAZE', 3::numeric),
      ('FG-PINEAPPL-GINGER', 11::numeric),
      ('FG-PINEAPPL-LEMON-GINGER-TROPIC', 25::numeric),
      ('FG-PINEAPPL-GRAPEFRU-TROPIC-TWI', 7::numeric),
      ('FG-TIGERNUT-GINGER', 13::numeric),
      ('FG-WATERMEL-JUICE', 20::numeric),
      ('FG-SWEET-RED', 9::numeric),
      ('FG-SWEET-GREEN', 19::numeric),
      ('FG-PINEAPPL-BANANA-YOGHURT-PBY', 15::numeric),
      ('FG-STRAWBER-BANANA-PINEAPPL-SBP', 5::numeric),
      ('FG-BEETROOT-BANANA-PINEAPPL-YOG', 4::numeric),
      ('FG-CREAMY-YOGHURT', 26::numeric),
      ('FG-PARFAIT-CLASSIC', 84::numeric),
      ('FG-PARFAIT-PREMIUM', 1::numeric),
      ('FG-GREEK-YOGHURT-SWEETENE', 5::numeric),
      ('FG-GREEK-YOGHURT-UNSWEETE', 5::numeric),
      ('FG-GRANOLA-100G', 5::numeric),
      ('FG-KULIKULI', 3::numeric),
      ('FG-SMOOTHIE-POPS', 31::numeric)
  )
  INSERT INTO public.inventory_movements (
    item_id, type, quantity, reason, location_id, source, performed_by
  )
  SELECT
    i.id,
    'opening_balance'::public.movement_type,
    c.quantity,
    'Go-live physical count from 27 July 2026 stock sheet',
    v_main_store_id,
    'go_live_opening_count_2026_07_27',
    NULL
  FROM opening_counts c
  JOIN public.inventory_items i ON i.sku = c.sku;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 27 THEN
    RAISE EXCEPTION 'Opening count item match failed: expected 27 non-zero items, matched %', v_inserted;
  END IF;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    NULL,
    'system.go_live_reset_completed',
    'go_live_reset_archives',
    v_archive_id::text,
    jsonb_build_object(
      'reset_key', v_reset_key,
      'main_store_location_id', v_main_store_id,
      'active_items_reset', (SELECT count(*) FROM public.inventory_items WHERE status = 'active'),
      'non_zero_opening_items', v_inserted,
      'opening_quantity_total', 686,
      'source', 'IMG_0962.jpeg, IMG_0963.jpeg and continuation stock-count image'
    )
  );

  v_result := jsonb_build_object(
    'status', 'completed',
    'reset_key', v_reset_key,
    'archive_id', v_archive_id,
    'non_zero_opening_items', v_inserted,
    'opening_quantity_total', 686
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.perform_go_live_reset(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perform_go_live_reset(text) TO service_role;

-- Generalize the morning request copy now that replenishment serves more than
-- one shop. The routing itself was already location- and shop-aware.
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
  VALUES(auth.uid(),v_need.item_id,v_need.requested_quantity,'Morning replenishment from configured shop target',v_shop_id,'approved',auth.uid(),
    'Policy-generated morning quantity reviewed by Inventory',now(),_client_reference_id,'morning',v_need.source_location_id,v_need.location_id,
    v_need.requested_quantity,'approved',v_need.id) RETURNING id INTO v_request_id;
  UPDATE public.purchase_needs SET status='sourcing',reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() WHERE id=v_need.id;
  INSERT INTO public.audit_log(user_id,action,entity,entity_id,new_value) VALUES(auth.uid(),'replenishment.morning_prepared','stock_requests',v_request_id::text,jsonb_build_object('need_id',v_need.id,'quantity',v_need.requested_quantity));
  RETURN v_request_id;
END; $$;

REVOKE ALL ON FUNCTION public.prepare_morning_replenishment(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_morning_replenishment(uuid,text) TO authenticated;
