-- Central stocktakes are final on submission. Posting creates auditable,
-- location-aware adjustment movements and no longer requires a second approval.

ALTER TABLE public.central_stocktakes
  DROP CONSTRAINT IF EXISTS central_stocktakes_status_check;

ALTER TABLE public.central_stocktakes
  ADD CONSTRAINT central_stocktakes_status_check
  CHECK (status IN ('draft', 'submitted', 'posted', 'approved', 'rejected'));

CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_central_stocktake_source_uidx
  ON public.inventory_movements (source)
  WHERE source LIKE 'central_stocktake:%';

CREATE OR REPLACE FUNCTION public.submit_central_stocktake(_stocktake_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stocktake public.central_stocktakes%ROWTYPE;
  v_line record;
  v_movement_count integer := 0;
  v_inserted integer := 0;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','admin','management','operations_manager','inventory_officer']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Not authorized to submit a Central stocktake'; END IF;

  SELECT * INTO v_stocktake
  FROM public.central_stocktakes
  WHERE id = _stocktake_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Central stocktake was not found'; END IF;
  IF v_stocktake.status = 'posted' THEN RETURN; END IF;
  IF v_stocktake.status NOT IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'Only a draft or previously submitted stocktake can be posted';
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

  FOR v_line IN
    SELECT *
    FROM public.central_stocktake_lines
    WHERE stocktake_id = _stocktake_id AND difference <> 0
    FOR UPDATE
  LOOP
    INSERT INTO public.inventory_movements (
      item_id, type, quantity, reason, location_id, source, performed_by
    )
    VALUES (
      v_line.item_id,
      CASE
        WHEN v_line.difference > 0 THEN 'adjustment_in'::public.movement_type
        ELSE 'adjustment_out'::public.movement_type
      END,
      abs(v_line.difference),
      'Central stocktake ' || v_stocktake.count_number || ': ' || v_line.variance_reason,
      v_stocktake.location_id,
      'central_stocktake:' || v_stocktake.id::text || ':' || v_line.id::text,
      auth.uid()
    )
    ON CONFLICT (source) WHERE source LIKE 'central_stocktake:%' DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    v_movement_count := v_movement_count + v_inserted;
  END LOOP;

  UPDATE public.central_stocktakes
  SET status = 'posted',
      submitted_by = COALESCE(submitted_by, auth.uid()),
      submitted_at = COALESCE(submitted_at, now()),
      reviewed_by = NULL,
      reviewed_at = NULL
  WHERE id = _stocktake_id;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(),
    'central_stocktake.submitted_and_posted',
    'central_stocktakes',
    _stocktake_id::text,
    jsonb_build_object(
      'adjustment_movements', v_movement_count,
      'posting_method', 'automatic_submission'
    )
  );
END;
$$;

-- Backward compatibility for a stale client that still displays Approve.
-- The same idempotent posting path is used, with the enum cast fixed.
CREATE OR REPLACE FUNCTION public.approve_central_stocktake(_stocktake_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Not authorized to post a Central stocktake'; END IF;

  PERFORM public.submit_central_stocktake(_stocktake_id);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_central_stocktake(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_central_stocktake(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_central_stocktake(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_central_stocktake(uuid) TO authenticated;

-- Recover valid stocktakes stranded in submitted by the former approval bug.
-- The source index and status transition make this rerunnable without duplicate movements.
DO $$
DECLARE
  v_stocktake public.central_stocktakes%ROWTYPE;
  v_line record;
  v_actor uuid;
  v_movement_count integer;
  v_inserted integer;
BEGIN
  FOR v_stocktake IN
    SELECT * FROM public.central_stocktakes
    WHERE status = 'submitted'
    ORDER BY submitted_at, created_at
    FOR UPDATE
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.central_stocktake_lines
      WHERE stocktake_id = v_stocktake.id AND counted_quantity IS NULL
    ) OR EXISTS (
      SELECT 1 FROM public.central_stocktake_lines
      WHERE stocktake_id = v_stocktake.id
        AND counted_quantity <> expected_quantity
        AND COALESCE(btrim(variance_reason), '') = ''
    ) THEN
      RAISE EXCEPTION 'Submitted stocktake % is incomplete and cannot be recovered',
        v_stocktake.count_number;
    END IF;

    v_actor := COALESCE(v_stocktake.submitted_by, v_stocktake.created_by);
    v_movement_count := 0;

    FOR v_line IN
      SELECT *
      FROM public.central_stocktake_lines
      WHERE stocktake_id = v_stocktake.id AND difference <> 0
      FOR UPDATE
    LOOP
      INSERT INTO public.inventory_movements (
        item_id, type, quantity, reason, location_id, source, performed_by
      )
      VALUES (
        v_line.item_id,
        CASE
          WHEN v_line.difference > 0 THEN 'adjustment_in'::public.movement_type
          ELSE 'adjustment_out'::public.movement_type
        END,
        abs(v_line.difference),
        'Central stocktake ' || v_stocktake.count_number || ': ' || v_line.variance_reason,
        v_stocktake.location_id,
        'central_stocktake:' || v_stocktake.id::text || ':' || v_line.id::text,
        v_actor
      )
      ON CONFLICT (source) WHERE source LIKE 'central_stocktake:%' DO NOTHING;

      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      v_movement_count := v_movement_count + v_inserted;
    END LOOP;

    UPDATE public.central_stocktakes
    SET status = 'posted', reviewed_by = NULL, reviewed_at = NULL
    WHERE id = v_stocktake.id;

    INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
    VALUES (
      v_actor,
      'central_stocktake.recovered_and_posted',
      'central_stocktakes',
      v_stocktake.id::text,
      jsonb_build_object(
        'adjustment_movements', v_movement_count,
        'posting_method', 'migration_recovery'
      )
    );
  END LOOP;
END;
$$;
