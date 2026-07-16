
-- 1. Target level per shop assortment
ALTER TABLE public.shop_assortments
  ADD COLUMN IF NOT EXISTS target_level NUMERIC NOT NULL DEFAULT 0;

-- 2. View: daily balance per shop/item
CREATE OR REPLACE VIEW public.v_shop_daily_balance
WITH (security_invoker = true) AS
WITH opening AS (
  SELECT c.shop_id, c.count_date, l.item_id, l.quantity_counted AS opening_qty,
         c.status AS opening_status, c.id AS opening_id
  FROM public.shop_stock_counts c
  JOIN public.shop_stock_count_lines l ON l.count_id = c.id
  WHERE c.count_type = 'opening'
),
closing AS (
  SELECT c.shop_id, c.count_date, l.item_id, l.quantity_counted AS closing_qty,
         c.status AS closing_status, c.id AS closing_id
  FROM public.shop_stock_counts c
  JOIN public.shop_stock_count_lines l ON l.count_id = c.id
  WHERE c.count_type = 'closing'
),
recv AS (
  SELECT m.to_shop_id AS shop_id, (m.created_at AT TIME ZONE 'UTC')::date AS d,
         m.item_id, SUM(abs(m.quantity)) AS qty
  FROM public.inventory_movements m
  WHERE m.to_shop_id IS NOT NULL AND m.type IN ('stock_out','sale')
  GROUP BY 1,2,3
),
ret AS (
  SELECT m.from_shop_id AS shop_id, (m.created_at AT TIME ZONE 'UTC')::date AS d,
         m.item_id, SUM(abs(m.quantity)) AS qty
  FROM public.inventory_movements m
  WHERE m.from_shop_id IS NOT NULL AND m.type IN ('stock_in','adjustment_in')
  GROUP BY 1,2,3
)
SELECT
  COALESCE(o.shop_id, c.shop_id) AS shop_id,
  COALESCE(o.count_date, c.count_date) AS count_date,
  COALESCE(o.item_id, c.item_id) AS item_id,
  o.opening_qty,
  o.opening_id,
  o.opening_status,
  COALESCE(r.qty, 0) AS received,
  COALESCE(rt.qty, 0) AS returned,
  c.closing_qty AS actual_closing,
  c.closing_id,
  c.closing_status,
  (COALESCE(o.opening_qty,0) + COALESCE(r.qty,0) - COALESCE(rt.qty,0)) AS expected_closing,
  (c.closing_qty - (COALESCE(o.opening_qty,0) + COALESCE(r.qty,0) - COALESCE(rt.qty,0))) AS variance,
  sa.target_level,
  GREATEST(COALESCE(sa.target_level,0) - COALESCE(c.closing_qty, o.opening_qty, 0), 0) AS restock_recommendation
FROM opening o
FULL JOIN closing c
  ON c.shop_id = o.shop_id AND c.count_date = o.count_date AND c.item_id = o.item_id
LEFT JOIN recv r
  ON r.shop_id = COALESCE(o.shop_id, c.shop_id)
 AND r.d = COALESCE(o.count_date, c.count_date)
 AND r.item_id = COALESCE(o.item_id, c.item_id)
LEFT JOIN ret rt
  ON rt.shop_id = COALESCE(o.shop_id, c.shop_id)
 AND rt.d = COALESCE(o.count_date, c.count_date)
 AND rt.item_id = COALESCE(o.item_id, c.item_id)
LEFT JOIN public.shop_assortments sa
  ON sa.shop_id = COALESCE(o.shop_id, c.shop_id)
 AND sa.item_id = COALESCE(o.item_id, c.item_id);

GRANT SELECT ON public.v_shop_daily_balance TO authenticated;

-- 3. View: pending closings (opening submitted but no submitted closing)
CREATE OR REPLACE VIEW public.v_shop_pending_closings
WITH (security_invoker = true) AS
SELECT o.shop_id, s.name AS shop_name, o.count_date, o.id AS opening_id,
       cc.id AS closing_id, cc.status AS closing_status
FROM public.shop_stock_counts o
JOIN public.shops s ON s.id = o.shop_id
LEFT JOIN public.shop_stock_counts cc
  ON cc.shop_id = o.shop_id AND cc.count_date = o.count_date AND cc.count_type = 'closing'
WHERE o.count_type = 'opening'
  AND o.status = 'submitted'
  AND (cc.id IS NULL OR cc.status <> 'submitted');

GRANT SELECT ON public.v_shop_pending_closings TO authenticated;

-- 4. Trigger: when an opening count is submitted, auto-create draft closing with same items
CREATE OR REPLACE FUNCTION public.ensure_closing_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_closing_id UUID;
BEGIN
  IF NEW.count_type = 'opening'
     AND NEW.status = 'submitted'
     AND (OLD.status IS DISTINCT FROM 'submitted') THEN

    SELECT id INTO v_closing_id
    FROM public.shop_stock_counts
    WHERE shop_id = NEW.shop_id
      AND count_date = NEW.count_date
      AND count_type = 'closing';

    IF v_closing_id IS NULL THEN
      INSERT INTO public.shop_stock_counts (shop_id, count_date, count_type, status, notes)
      VALUES (NEW.shop_id, NEW.count_date, 'closing', 'draft',
              'Auto-created — closing required to balance the day')
      RETURNING id INTO v_closing_id;

      -- Seed lines from the opening count so the same items appear
      INSERT INTO public.shop_stock_count_lines (count_id, item_id, quantity_counted)
      SELECT v_closing_id, l.item_id, 0
      FROM public.shop_stock_count_lines l
      WHERE l.count_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_closing_count ON public.shop_stock_counts;
CREATE TRIGGER trg_ensure_closing_count
AFTER UPDATE ON public.shop_stock_counts
FOR EACH ROW EXECUTE FUNCTION public.ensure_closing_count();

-- 5. Trigger: on closing submit, notify ops if any large variance
CREATE OR REPLACE FUNCTION public.notify_closing_variance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_variance_lines INT;
  v_shop_name TEXT;
  v_recipient RECORD;
BEGIN
  IF NEW.count_type = 'closing'
     AND NEW.status = 'submitted'
     AND (OLD.status IS DISTINCT FROM 'submitted') THEN

    SELECT count(*) INTO v_variance_lines
    FROM public.v_shop_daily_balance
    WHERE shop_id = NEW.shop_id
      AND count_date = NEW.count_date
      AND abs(COALESCE(variance,0)) > 0;

    SELECT name INTO v_shop_name FROM public.shops WHERE id = NEW.shop_id;

    FOR v_recipient IN
      SELECT DISTINCT ur.user_id FROM public.user_roles ur
      WHERE ur.role IN ('super_admin','management','operations_manager','inventory_officer')
    LOOP
      INSERT INTO public.notifications (user_id, title, body, level, link)
      VALUES (v_recipient.user_id,
        'Closing count submitted — ' || v_shop_name,
        v_shop_name || ' closed ' || NEW.count_date::text ||
          CASE WHEN v_variance_lines > 0
               THEN ' with ' || v_variance_lines::text || ' item(s) variance — review restock.'
               ELSE ' — no variance.' END,
        CASE WHEN v_variance_lines > 0 THEN 'warn'::notification_level ELSE 'info'::notification_level END,
        '/shop-counts/' || NEW.id::text);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_closing_variance ON public.shop_stock_counts;
CREATE TRIGGER trg_notify_closing_variance
AFTER UPDATE ON public.shop_stock_counts
FOR EACH ROW EXECUTE FUNCTION public.notify_closing_variance();
