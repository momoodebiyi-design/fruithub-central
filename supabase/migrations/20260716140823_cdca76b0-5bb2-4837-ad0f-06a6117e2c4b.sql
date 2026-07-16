
-- 1. Guard trigger: block new opening if previous-day closing missing (management can override)
CREATE OR REPLACE FUNCTION public.guard_previous_closing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_prev DATE := NEW.count_date - INTERVAL '1 day';
  v_prev_open BOOLEAN;
  v_prev_closed BOOLEAN;
BEGIN
  IF NEW.count_type <> 'opening' THEN RETURN NEW; END IF;
  SELECT EXISTS(SELECT 1 FROM public.shop_stock_counts
    WHERE shop_id=NEW.shop_id AND count_date=v_prev
      AND count_type='opening' AND status='submitted') INTO v_prev_open;
  IF NOT v_prev_open THEN RETURN NEW; END IF;
  SELECT EXISTS(SELECT 1 FROM public.shop_stock_counts
    WHERE shop_id=NEW.shop_id AND count_date=v_prev
      AND count_type='closing' AND status='submitted') INTO v_prev_closed;
  IF NOT v_prev_closed AND NOT public.has_any_role(auth.uid(),
     ARRAY['super_admin','management']::app_role[]) THEN
    RAISE EXCEPTION 'Previous day (%) closing count is not submitted for this shop. Complete it before opening a new day.', v_prev
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_previous_closing ON public.shop_stock_counts;
CREATE TRIGGER trg_guard_previous_closing
  BEFORE INSERT ON public.shop_stock_counts
  FOR EACH ROW EXECUTE FUNCTION public.guard_previous_closing();

-- 2. Rebuild daily balance view to include sales/waste/damage/expiry at shops
DROP VIEW IF EXISTS public.v_shop_daily_balance CASCADE;
CREATE VIEW public.v_shop_daily_balance AS
WITH opening AS (
  SELECT c.shop_id, c.count_date, l.item_id, l.quantity_counted AS opening_qty,
    c.status AS opening_status, c.id AS opening_id
  FROM public.shop_stock_counts c
  JOIN public.shop_stock_count_lines l ON l.count_id=c.id
  WHERE c.count_type='opening'
), closing AS (
  SELECT c.shop_id, c.count_date, l.item_id, l.quantity_counted AS closing_qty,
    c.status AS closing_status, c.id AS closing_id
  FROM public.shop_stock_counts c
  JOIN public.shop_stock_count_lines l ON l.count_id=c.id
  WHERE c.count_type='closing'
), recv AS (
  SELECT m.to_shop_id AS shop_id, (m.created_at AT TIME ZONE 'UTC')::date AS d,
    m.item_id, sum(abs(m.quantity)) AS qty
  FROM public.inventory_movements m
  WHERE m.to_shop_id IS NOT NULL
    AND m.type IN ('stock_out','adjustment_in')
  GROUP BY 1,2,3
), ret AS (
  SELECT m.from_shop_id AS shop_id, (m.created_at AT TIME ZONE 'UTC')::date AS d,
    m.item_id, sum(abs(m.quantity)) AS qty
  FROM public.inventory_movements m
  WHERE m.from_shop_id IS NOT NULL
    AND m.type = 'stock_in'
  GROUP BY 1,2,3
), sold_wasted AS (
  SELECT m.from_shop_id AS shop_id, (m.created_at AT TIME ZONE 'UTC')::date AS d,
    m.item_id,
    sum(CASE WHEN m.type='sale' THEN abs(m.quantity) ELSE 0 END) AS sold,
    sum(CASE WHEN m.type IN ('damaged','expired','wastage','adjustment_out') THEN abs(m.quantity) ELSE 0 END) AS wasted
  FROM public.inventory_movements m
  WHERE m.from_shop_id IS NOT NULL
    AND m.type IN ('sale','damaged','expired','wastage','adjustment_out')
  GROUP BY 1,2,3
)
SELECT COALESCE(o.shop_id, c.shop_id) AS shop_id,
  COALESCE(o.count_date, c.count_date) AS count_date,
  COALESCE(o.item_id, c.item_id) AS item_id,
  o.opening_qty, o.opening_id, o.opening_status,
  COALESCE(r.qty,0) AS received,
  COALESCE(rt.qty,0) AS returned,
  COALESCE(sw.sold,0) AS sold,
  COALESCE(sw.wasted,0) AS wasted,
  c.closing_qty AS actual_closing, c.closing_id, c.closing_status,
  COALESCE(o.opening_qty,0) + COALESCE(r.qty,0) - COALESCE(rt.qty,0)
    - COALESCE(sw.sold,0) - COALESCE(sw.wasted,0) AS expected_closing,
  c.closing_qty - (COALESCE(o.opening_qty,0) + COALESCE(r.qty,0) - COALESCE(rt.qty,0)
    - COALESCE(sw.sold,0) - COALESCE(sw.wasted,0)) AS variance,
  sa.target_level,
  GREATEST(COALESCE(sa.target_level,0) - COALESCE(c.closing_qty, o.opening_qty, 0), 0) AS restock_recommendation
FROM opening o
FULL JOIN closing c
  ON c.shop_id=o.shop_id AND c.count_date=o.count_date AND c.item_id=o.item_id
LEFT JOIN recv r
  ON r.shop_id=COALESCE(o.shop_id,c.shop_id) AND r.d=COALESCE(o.count_date,c.count_date) AND r.item_id=COALESCE(o.item_id,c.item_id)
LEFT JOIN ret rt
  ON rt.shop_id=COALESCE(o.shop_id,c.shop_id) AND rt.d=COALESCE(o.count_date,c.count_date) AND rt.item_id=COALESCE(o.item_id,c.item_id)
LEFT JOIN sold_wasted sw
  ON sw.shop_id=COALESCE(o.shop_id,c.shop_id) AND sw.d=COALESCE(o.count_date,c.count_date) AND sw.item_id=COALESCE(o.item_id,c.item_id)
LEFT JOIN public.shop_assortments sa
  ON sa.shop_id=COALESCE(o.shop_id,c.shop_id) AND sa.item_id=COALESCE(o.item_id,c.item_id);

GRANT SELECT ON public.v_shop_daily_balance TO authenticated;

-- 3. Top restock recommendations view (latest submitted closing per shop+item)
CREATE OR REPLACE VIEW public.v_shop_top_restock AS
WITH latest AS (
  SELECT DISTINCT ON (shop_id, item_id)
    shop_id, item_id, count_date, actual_closing, target_level,
    restock_recommendation, closing_status
  FROM public.v_shop_daily_balance
  WHERE closing_status = 'submitted' AND restock_recommendation > 0
  ORDER BY shop_id, item_id, count_date DESC
)
SELECT l.shop_id, l.item_id, l.count_date, l.actual_closing, l.target_level,
  l.restock_recommendation,
  s.name AS shop_name, i.name AS item_name, i.sku, i.unit
FROM latest l
JOIN public.shops s ON s.id=l.shop_id
JOIN public.inventory_items i ON i.id=l.item_id
WHERE s.is_active;

GRANT SELECT ON public.v_shop_top_restock TO authenticated;
