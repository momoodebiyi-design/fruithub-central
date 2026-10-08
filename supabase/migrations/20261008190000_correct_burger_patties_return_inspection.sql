-- Business-owner-confirmed correction of RET-20261008-0003.
-- The two physically returned Burger Patties were sellable, but were saved
-- as rejected. Preserve the original event and record this later correction.
DO $$
DECLARE
  v_line public.dispatch_return_lines%ROWTYPE;
  v_return public.dispatch_returns%ROWTYPE;
  v_dispatch public.dispatches%ROWTYPE;
  v_source text;
BEGIN
  SELECT * INTO v_line
  FROM public.dispatch_return_lines
  WHERE return_id = '09349489-330c-4033-a0cb-b3dff8c1bff8'
    AND dispatch_line_id = '2f75cfa8-9b32-4bd9-bc7b-57ff1d0a8ab5'
    AND item_id = '288566a3-6231-4269-9e1f-baf6a61e0c88'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN; -- No production record in a fresh or test database.
  END IF;

  v_source := 'factory_return_inspection_correction:' || v_line.return_id::text
    || ':' || v_line.id::text;

  IF v_line.quantity_accepted = 2 AND v_line.quantity_rejected = 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.inventory_movements
      WHERE source = v_source AND item_id = v_line.item_id
        AND type = 'stock_in' AND quantity = 2
    ) THEN
      RAISE EXCEPTION 'Return is corrected but its Central stock-in is missing';
    END IF;
    RETURN;
  END IF;

  IF v_line.quantity_returned <> 2
     OR v_line.quantity_accepted <> 0
     OR v_line.quantity_rejected <> 2 THEN
    RAISE EXCEPTION 'Return inspection differs from the verified pre-correction state';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_movements WHERE source = v_source) THEN
    RAISE EXCEPTION 'Correction stock movement already exists';
  END IF;

  SELECT * INTO STRICT v_return
  FROM public.dispatch_returns WHERE id = v_line.return_id;
  SELECT * INTO STRICT v_dispatch
  FROM public.dispatches WHERE id = v_return.dispatch_id;
  IF v_return.return_number <> 'RET-20261008-0003'
     OR v_dispatch.reference <> 'DSP-MUZDM79K'
     OR v_dispatch.source_location_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.locations
       WHERE id = v_dispatch.source_location_id
         AND status = 'active' AND (is_default OR lower(name) = 'main store')
     ) THEN
    RAISE EXCEPTION 'Return identity or Central location did not match the verified record';
  END IF;

  UPDATE public.dispatch_return_lines
  SET quantity_accepted = 2, quantity_rejected = 0
  WHERE id = v_line.id;

  INSERT INTO public.inventory_movements (
    item_id, type, quantity, reason, dispatch_id, location_id, source
  ) VALUES (
    v_line.item_id, 'stock_in'::public.movement_type, 2,
    'Sellable return inspection correction for ' || v_return.return_number,
    v_dispatch.id, v_dispatch.source_location_id, v_source
  );

  INSERT INTO public.audit_log (
    user_id, action, entity, entity_id, previous_value, new_value
  ) VALUES (
    NULL, 'dispatch.factory_return_inspection_corrected',
    'dispatch_returns', v_return.id::text,
    jsonb_build_object(
      'item_id', v_line.item_id, 'quantity_returned', 2,
      'quantity_accepted', 0, 'quantity_rejected', 2
    ),
    jsonb_build_object(
      'item_id', v_line.item_id, 'quantity_returned', 2,
      'quantity_accepted', 2, 'quantity_rejected', 0,
      'stock_movement_source', v_source,
      'basis', 'Business owner confirmed two Burger Patties were inspected and sellable'
    )
  );
END;
$$;
