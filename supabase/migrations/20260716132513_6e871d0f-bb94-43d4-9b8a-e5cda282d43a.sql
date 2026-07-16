-- Trigger closing count creation as soon as an opening count exists (on insert),
-- and re-seed lines from opening when opening is submitted so cashiers start
-- from the same list/quantities.
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

  -- Fire on insert of an opening count, OR when opening transitions to submitted
  IF TG_OP = 'UPDATE' AND NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    v_seed_from_submit := true;
  ELSIF TG_OP <> 'INSERT' AND NOT v_seed_from_submit THEN
    RETURN NEW;
  END IF;

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
  END IF;

  -- Seed / refresh lines from the opening count so the same items appear
  -- with opening quantities as the starting value (only if closing not yet submitted).
  IF EXISTS (SELECT 1 FROM public.shop_stock_counts WHERE id = v_closing_id AND status = 'draft') THEN
    -- Remove existing draft lines and reseed from opening
    DELETE FROM public.shop_stock_count_lines WHERE count_id = v_closing_id;

    INSERT INTO public.shop_stock_count_lines (count_id, item_id, quantity_counted, notes)
    SELECT v_closing_id, l.item_id, l.quantity_counted, NULL
    FROM public.shop_stock_count_lines l
    WHERE l.count_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_closing_count ON public.shop_stock_counts;
CREATE TRIGGER trg_ensure_closing_count
AFTER INSERT OR UPDATE OF status ON public.shop_stock_counts
FOR EACH ROW
EXECUTE FUNCTION public.ensure_closing_count();

-- Also seed closing lines whenever new opening lines are added/updated,
-- so if the supervisor edits opening items pre-submit, closing stays in sync.
CREATE OR REPLACE FUNCTION public.sync_closing_lines_from_opening()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_opening public.shop_stock_counts%ROWTYPE;
  v_closing_id UUID;
BEGIN
  SELECT * INTO v_opening FROM public.shop_stock_counts WHERE id = NEW.count_id;
  IF v_opening.id IS NULL OR v_opening.count_type <> 'opening' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_closing_id
  FROM public.shop_stock_counts
  WHERE shop_id = v_opening.shop_id
    AND count_date = v_opening.count_date
    AND count_type = 'closing'
    AND status = 'draft';

  IF v_closing_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Upsert this line into the closing draft
  INSERT INTO public.shop_stock_count_lines (count_id, item_id, quantity_counted)
  VALUES (v_closing_id, NEW.item_id, NEW.quantity_counted)
  ON CONFLICT (count_id, item_id) DO UPDATE
    SET quantity_counted = EXCLUDED.quantity_counted;

  RETURN NEW;
END;
$$;

-- Ensure the unique constraint exists for the ON CONFLICT above
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shop_stock_count_lines_count_item_uniq'
  ) THEN
    ALTER TABLE public.shop_stock_count_lines
      ADD CONSTRAINT shop_stock_count_lines_count_item_uniq UNIQUE (count_id, item_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_sync_closing_lines ON public.shop_stock_count_lines;
CREATE TRIGGER trg_sync_closing_lines
AFTER INSERT OR UPDATE ON public.shop_stock_count_lines
FOR EACH ROW
EXECUTE FUNCTION public.sync_closing_lines_from_opening();

REVOKE EXECUTE ON FUNCTION public.ensure_closing_count() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_closing_lines_from_opening() FROM PUBLIC, anon, authenticated;
