-- Fix: previous version referenced a non-existent "notes" column on shop_stock_count_lines
CREATE OR REPLACE FUNCTION public.ensure_closing_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_closing_id UUID;
  v_seed_from_submit BOOLEAN := false;
BEGIN
  IF NEW.count_type <> 'opening' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    v_seed_from_submit := true;
  ELSIF TG_OP <> 'INSERT' AND NOT v_seed_from_submit THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_closing_id
  FROM public.shop_stock_counts
  WHERE shop_id = NEW.shop_id AND count_date = NEW.count_date AND count_type = 'closing';

  IF v_closing_id IS NULL THEN
    INSERT INTO public.shop_stock_counts (shop_id, count_date, count_type, status, notes)
    VALUES (NEW.shop_id, NEW.count_date, 'closing', 'draft',
            'Auto-created — closing required to balance the day')
    RETURNING id INTO v_closing_id;
  END IF;

  IF EXISTS (SELECT 1 FROM public.shop_stock_counts WHERE id = v_closing_id AND status = 'draft') THEN
    DELETE FROM public.shop_stock_count_lines WHERE count_id = v_closing_id;
    INSERT INTO public.shop_stock_count_lines (count_id, item_id, quantity_counted)
    SELECT v_closing_id, l.item_id, l.quantity_counted
    FROM public.shop_stock_count_lines l
    WHERE l.count_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Admin-only delete RPC
CREATE OR REPLACE FUNCTION public.delete_shop_stock_count(_count_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count public.shop_stock_counts%ROWTYPE;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management']::app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to delete shop counts';
  END IF;
  SELECT * INTO v_count FROM public.shop_stock_counts WHERE id = _count_id;
  IF v_count.id IS NULL THEN RAISE EXCEPTION 'Count not found'; END IF;

  DELETE FROM public.shop_stock_count_lines WHERE count_id = _count_id;
  DELETE FROM public.shop_stock_counts WHERE id = _count_id;

  -- If we deleted an opening, also remove its auto-created draft closing (if untouched)
  IF v_count.count_type = 'opening' THEN
    DELETE FROM public.shop_stock_count_lines
      WHERE count_id IN (SELECT id FROM public.shop_stock_counts
                         WHERE shop_id = v_count.shop_id AND count_date = v_count.count_date
                           AND count_type = 'closing' AND status = 'draft');
    DELETE FROM public.shop_stock_counts
      WHERE shop_id = v_count.shop_id AND count_date = v_count.count_date
        AND count_type = 'closing' AND status = 'draft';
  END IF;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'stock_count.deleted', 'shop_stock_counts', _count_id::text,
    jsonb_build_object('shop_id', v_count.shop_id, 'date', v_count.count_date, 'type', v_count.count_type));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_shop_stock_count(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_shop_stock_count(uuid) TO authenticated;
