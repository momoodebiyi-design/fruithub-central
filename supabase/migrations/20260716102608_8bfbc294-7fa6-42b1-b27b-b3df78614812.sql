
CREATE TABLE IF NOT EXISTS public.locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  location_type TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.locations TO authenticated;
GRANT ALL ON public.locations TO service_role;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS locations_read ON public.locations;
CREATE POLICY locations_read ON public.locations FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS locations_write ON public.locations;
CREATE POLICY locations_write ON public.locations FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager']::app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager']::app_role[]));

INSERT INTO public.locations (location_id, name, location_type, is_default, notes)
VALUES ('LOC0001','Main Store','Primary',true,'Default location from Milestone 1 import')
ON CONFLICT (location_id) DO NOTHING;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS item_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS subcategory TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS aliases TEXT[],
  ADD COLUMN IF NOT EXISTS standard_cost NUMERIC,
  ADD COLUMN IF NOT EXISTS import_notes TEXT,
  ADD COLUMN IF NOT EXISTS default_location_id UUID REFERENCES public.locations(id);

ALTER TABLE public.inventory_items ALTER COLUMN purchase_cost DROP NOT NULL;
ALTER TABLE public.inventory_items ALTER COLUMN purchase_cost SET DEFAULT 0;
ALTER TABLE public.inventory_items ALTER COLUMN min_level SET DEFAULT 0;
ALTER TABLE public.inventory_items ALTER COLUMN reorder_level SET DEFAULT 0;
ALTER TABLE public.inventory_items ALTER COLUMN quantity SET DEFAULT 0;

ALTER TABLE public.inventory_movements
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES public.locations(id),
  ADD COLUMN IF NOT EXISTS source TEXT;

UPDATE public.inventory_movements SET location_id = (SELECT id FROM public.locations WHERE location_id='LOC0001') WHERE location_id IS NULL;
UPDATE public.inventory_items SET default_location_id = (SELECT id FROM public.locations WHERE location_id='LOC0001') WHERE default_location_id IS NULL;

CREATE OR REPLACE VIEW public.v_item_stock AS
SELECT ii.id AS item_id, ii.item_id AS item_code, ii.sku, ii.name, ii.category, ii.subcategory,
  ii.unit, ii.min_level, ii.reorder_level, ii.status,
  COALESCE(SUM(CASE
    WHEN m.type IN ('stock_in','opening_balance','receipt','adjustment_in','production_output') THEN abs(m.quantity)
    WHEN m.type IN ('stock_out','sale','damaged','expired','wastage','production_consume','adjustment_out') THEN -abs(m.quantity)
    WHEN m.type = 'adjustment' THEN m.quantity
    ELSE 0 END), 0) AS on_hand
FROM public.inventory_items ii
LEFT JOIN public.inventory_movements m ON m.item_id = ii.id
GROUP BY ii.id;
GRANT SELECT ON public.v_item_stock TO authenticated;

CREATE OR REPLACE FUNCTION public.apply_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_delta NUMERIC; v_item public.inventory_items%ROWTYPE; v_new_qty NUMERIC; v_recipient RECORD;
BEGIN
  IF NEW.type IN ('stock_in','opening_balance','receipt','adjustment_in','production_output') THEN v_delta := abs(NEW.quantity);
  ELSIF NEW.type IN ('stock_out','sale','damaged','expired','wastage','production_consume','adjustment_out') THEN v_delta := -1 * abs(NEW.quantity);
  ELSIF NEW.type = 'adjustment' THEN v_delta := NEW.quantity;
  ELSE v_delta := 0; END IF;

  UPDATE public.inventory_items SET quantity = quantity + v_delta, updated_at = now()
    WHERE id = NEW.item_id RETURNING * INTO v_item;
  v_new_qty := v_item.quantity;
  IF v_item.min_level > 0 AND v_new_qty <= v_item.min_level AND v_delta < 0 THEN
    FOR v_recipient IN SELECT DISTINCT ur.user_id FROM public.user_roles ur
      WHERE ur.role IN ('super_admin','management','operations_manager','inventory_officer','procurement') LOOP
      INSERT INTO public.notifications (user_id, title, body, level, link)
      VALUES (v_recipient.user_id,
        CASE WHEN v_new_qty <= 0 THEN 'Out of stock: ' || v_item.name ELSE 'Low stock: ' || v_item.name END,
        COALESCE(v_item.sku,'') || ' — ' || v_new_qty::TEXT || ' ' || v_item.unit || ' remaining (min ' || v_item.min_level::TEXT || ')',
        CASE WHEN v_new_qty <= 0 THEN 'critical'::notification_level ELSE 'warn'::notification_level END,
        '/inventory/' || v_item.id::TEXT);
    END LOOP;
  END IF;
  RETURN NEW;
END $fn$;

CREATE TABLE IF NOT EXISTS public.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE, name TEXT NOT NULL,
  type public.customer_type NOT NULL DEFAULT 'retail',
  contact_name TEXT, email TEXT, phone TEXT, address TEXT, notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customers_read ON public.customers;
CREATE POLICY customers_read ON public.customers FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS customers_write ON public.customers;
CREATE POLICY customers_write ON public.customers FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','sales']::app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','sales']::app_role[]));

CREATE TABLE IF NOT EXISTS public.sales_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number TEXT UNIQUE NOT NULL,
  customer_id UUID REFERENCES public.customers(id),
  order_date DATE NOT NULL DEFAULT current_date,
  status public.sales_order_status NOT NULL DEFAULT 'draft',
  notes TEXT,
  fulfilled_at TIMESTAMPTZ, fulfilled_by UUID REFERENCES auth.users(id),
  voided_at TIMESTAMPTZ, voided_by UUID REFERENCES auth.users(id), void_reason TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_orders TO authenticated;
GRANT ALL ON public.sales_orders TO service_role;
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS so_read ON public.sales_orders;
CREATE POLICY so_read ON public.sales_orders FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS so_write ON public.sales_orders;
CREATE POLICY so_write ON public.sales_orders FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','sales']::app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','sales']::app_role[]));

CREATE TABLE IF NOT EXISTS public.sales_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id UUID NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_order_items TO authenticated;
GRANT ALL ON public.sales_order_items TO service_role;
ALTER TABLE public.sales_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS soi_read ON public.sales_order_items;
CREATE POLICY soi_read ON public.sales_order_items FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS soi_write ON public.sales_order_items;
CREATE POLICY soi_write ON public.sales_order_items FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','sales']::app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','sales']::app_role[]));

CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number TEXT UNIQUE NOT NULL,
  supplier_id UUID REFERENCES public.suppliers(id),
  order_date DATE NOT NULL DEFAULT current_date,
  expected_date DATE,
  status public.purchase_order_status NOT NULL DEFAULT 'draft',
  notes TEXT, created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_orders TO authenticated;
GRANT ALL ON public.purchase_orders TO service_role;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_read ON public.purchase_orders;
CREATE POLICY po_read ON public.purchase_orders FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS po_write ON public.purchase_orders;
CREATE POLICY po_write ON public.purchase_orders FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','procurement']::app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','procurement']::app_role[]));

CREATE TABLE IF NOT EXISTS public.purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  quantity_ordered NUMERIC NOT NULL CHECK (quantity_ordered > 0),
  quantity_received NUMERIC NOT NULL DEFAULT 0,
  unit_cost NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_order_items TO authenticated;
GRANT ALL ON public.purchase_order_items TO service_role;
ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS poi_read ON public.purchase_order_items;
CREATE POLICY poi_read ON public.purchase_order_items FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS poi_write ON public.purchase_order_items;
CREATE POLICY poi_write ON public.purchase_order_items FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','procurement']::app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','procurement']::app_role[]));

CREATE TABLE IF NOT EXISTS public.recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  version INT NOT NULL DEFAULT 1,
  yield_quantity NUMERIC, yield_unit TEXT, waste_pct NUMERIC DEFAULT 0,
  status public.recipe_status NOT NULL DEFAULT 'draft',
  notes TEXT,
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_item_id, version)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipes TO authenticated;
GRANT ALL ON public.recipes TO service_role;
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recipes_read ON public.recipes;
CREATE POLICY recipes_read ON public.recipes FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS recipes_write ON public.recipes;
CREATE POLICY recipes_write ON public.recipes FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','production']::app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','production']::app_role[]));

CREATE TABLE IF NOT EXISTS public.recipe_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES public.recipes(id) ON DELETE CASCADE,
  ingredient_item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  quantity NUMERIC, unit TEXT, waste_pct NUMERIC, notes TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipe_ingredients TO authenticated;
GRANT ALL ON public.recipe_ingredients TO service_role;
ALTER TABLE public.recipe_ingredients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ri_read ON public.recipe_ingredients;
CREATE POLICY ri_read ON public.recipe_ingredients FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ri_write ON public.recipe_ingredients;
CREATE POLICY ri_write ON public.recipe_ingredients FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','production']::app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','production']::app_role[]));

CREATE OR REPLACE FUNCTION public.fulfill_sales_order(_order_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_order public.sales_orders%ROWTYPE; v_line RECORD; v_stock NUMERIC;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','sales']::app_role[]) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO v_order FROM public.sales_orders WHERE id=_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_order.status NOT IN ('draft','confirmed') THEN RAISE EXCEPTION 'Cannot fulfill order in status %', v_order.status; END IF;
  FOR v_line IN SELECT * FROM public.sales_order_items WHERE sales_order_id=_order_id LOOP
    SELECT on_hand INTO v_stock FROM public.v_item_stock WHERE item_id=v_line.item_id;
    IF (v_stock IS NULL OR v_stock < v_line.quantity) AND NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management']::app_role[]) THEN
      RAISE EXCEPTION 'Insufficient stock for item %: have %, need %', v_line.item_id, COALESCE(v_stock,0), v_line.quantity;
    END IF;
    INSERT INTO public.inventory_movements (item_id, type, quantity, reason, source, performed_by)
    VALUES (v_line.item_id, 'sale', v_line.quantity, 'Sale order ' || v_order.order_number, 'sales_order:'||_order_id::text, auth.uid());
  END LOOP;
  UPDATE public.sales_orders SET status='fulfilled', fulfilled_at=now(), fulfilled_by=auth.uid(), updated_at=now() WHERE id=_order_id;
  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'sales_order.fulfilled', 'sales_orders', _order_id::text, jsonb_build_object('order_number', v_order.order_number));
END $fn$;
REVOKE EXECUTE ON FUNCTION public.fulfill_sales_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fulfill_sales_order(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_sales_order(_order_id UUID, _reason TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_order public.sales_orders%ROWTYPE; v_line RECORD;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager']::app_role[]) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO v_order FROM public.sales_orders WHERE id=_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_order.status = 'void' THEN RAISE EXCEPTION 'Already void'; END IF;
  IF v_order.status = 'fulfilled' THEN
    FOR v_line IN SELECT * FROM public.sales_order_items WHERE sales_order_id=_order_id LOOP
      INSERT INTO public.inventory_movements (item_id, type, quantity, reason, source, performed_by)
      VALUES (v_line.item_id, 'adjustment_in', v_line.quantity, 'Reversal of void sale ' || v_order.order_number, 'sales_order_void:'||_order_id::text, auth.uid());
    END LOOP;
  END IF;
  UPDATE public.sales_orders SET status='void', voided_at=now(), voided_by=auth.uid(), void_reason=_reason, updated_at=now() WHERE id=_order_id;
  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'sales_order.voided', 'sales_orders', _order_id::text, jsonb_build_object('reason', _reason));
END $fn$;
REVOKE EXECUTE ON FUNCTION public.void_sales_order(UUID,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_sales_order(UUID,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.receive_purchase_order(_po_id UUID, _lines JSONB)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_po public.purchase_orders%ROWTYPE; v_row JSONB; v_line public.purchase_order_items%ROWTYPE; v_qty NUMERIC; v_all BOOLEAN;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','procurement','inventory_officer']::app_role[]) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=_po_id FOR UPDATE;
  IF v_po.id IS NULL THEN RAISE EXCEPTION 'PO not found'; END IF;
  IF v_po.status IN ('received','cancelled') THEN RAISE EXCEPTION 'PO closed'; END IF;
  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO v_line FROM public.purchase_order_items WHERE id=(v_row->>'line_id')::uuid AND purchase_order_id=_po_id FOR UPDATE;
    IF v_line.id IS NULL THEN RAISE EXCEPTION 'Line not found'; END IF;
    v_qty := (v_row->>'quantity')::NUMERIC;
    IF v_qty <= 0 THEN CONTINUE; END IF;
    IF v_line.quantity_received + v_qty > v_line.quantity_ordered THEN RAISE EXCEPTION 'Receipt exceeds ordered on line %', v_line.id; END IF;
    UPDATE public.purchase_order_items SET quantity_received = quantity_received + v_qty WHERE id=v_line.id;
    INSERT INTO public.inventory_movements (item_id, type, quantity, reason, source, performed_by)
    VALUES (v_line.item_id, 'receipt', v_qty, 'PO ' || v_po.po_number, 'purchase_order:'||_po_id::text, auth.uid());
  END LOOP;
  SELECT bool_and(quantity_received >= quantity_ordered) INTO v_all FROM public.purchase_order_items WHERE purchase_order_id=_po_id;
  UPDATE public.purchase_orders SET status = CASE WHEN v_all THEN 'received'::purchase_order_status ELSE 'partial'::purchase_order_status END, updated_at=now() WHERE id=_po_id;
  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'purchase_order.received', 'purchase_orders', _po_id::text, jsonb_build_object('lines', _lines));
END $fn$;
REVOKE EXECUTE ON FUNCTION public.receive_purchase_order(UUID,JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order(UUID,JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_stock_adjustment(_item_id UUID, _quantity NUMERIC, _direction TEXT, _reason TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_id UUID; v_type movement_type;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _direction='in' THEN v_type := 'adjustment_in'; ELSIF _direction='out' THEN v_type := 'adjustment_out'; ELSE RAISE EXCEPTION 'direction must be in or out'; END IF;
  INSERT INTO public.inventory_movements (item_id, type, quantity, reason, source, performed_by)
  VALUES (_item_id, v_type, abs(_quantity), _reason, 'manual_adjustment', auth.uid()) RETURNING id INTO v_id;
  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'stock.adjusted', 'inventory_items', _item_id::text, jsonb_build_object('direction',_direction,'quantity',_quantity,'reason',_reason));
  RETURN v_id;
END $fn$;
REVOKE EXECUTE ON FUNCTION public.record_stock_adjustment(UUID,NUMERIC,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_stock_adjustment(UUID,NUMERIC,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_recipe(_recipe_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_missing INT;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager']::app_role[]) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT count(*) INTO v_missing FROM public.recipe_ingredients WHERE recipe_id=_recipe_id AND (quantity IS NULL OR unit IS NULL);
  IF v_missing > 0 THEN RAISE EXCEPTION 'Recipe has % ingredient(s) with missing quantity/unit', v_missing; END IF;
  UPDATE public.recipes SET status='approved', approved_by=auth.uid(), approved_at=now(), updated_at=now() WHERE id=_recipe_id;
  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'recipe.approved', 'recipes', _recipe_id::text, jsonb_build_object('recipe_id',_recipe_id));
END $fn$;
REVOKE EXECUTE ON FUNCTION public.approve_recipe(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_recipe(UUID) TO authenticated;

DO $$ DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['locations','customers','sales_orders','purchase_orders','recipes']) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t, t);
  END LOOP;
END $$;
