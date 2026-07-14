
-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM (
  'super_admin','management','operations_manager','production',
  'inventory_officer','procurement','admin','event_team','sales','readonly'
);

CREATE TYPE public.inventory_category AS ENUM (
  'packaging','raw_material','consumable','finished_good'
);

CREATE TYPE public.movement_type AS ENUM (
  'stock_in','stock_out','transfer','adjustment',
  'damaged','expired','wastage','production_consume','production_output'
);

CREATE TYPE public.batch_status AS ENUM (
  'planned','in_progress','completed','qc_passed','qc_failed'
);

CREATE TYPE public.notification_level AS ENUM ('info','warn','critical');

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  department TEXT,
  phone TEXT,
  avatar_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ============ USER ROLES ============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- has_role security definer to avoid recursive RLS
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE OR REPLACE FUNCTION public.has_any_role(_user_id UUID, _roles public.app_role[])
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = ANY(_roles)
  )
$$;

-- Profile policies
CREATE POLICY "profiles_read_self" ON public.profiles FOR SELECT
  TO authenticated USING (id = auth.uid());
CREATE POLICY "profiles_read_admin" ON public.profiles FOR SELECT
  TO authenticated USING (
    public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager']::public.app_role[])
  );
CREATE POLICY "profiles_update_self" ON public.profiles FOR UPDATE
  TO authenticated USING (id = auth.uid());
CREATE POLICY "profiles_update_admin" ON public.profiles FOR UPDATE
  TO authenticated USING (public.has_any_role(auth.uid(), ARRAY['super_admin','admin']::public.app_role[]));

-- user_roles policies
CREATE POLICY "user_roles_read_self" ON public.user_roles FOR SELECT
  TO authenticated USING (user_id = auth.uid());
CREATE POLICY "user_roles_read_admin" ON public.user_roles FOR SELECT
  TO authenticated USING (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management']::public.app_role[]));
CREATE POLICY "user_roles_write_admin" ON public.user_roles FOR ALL
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','admin']::public.app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','admin']::public.app_role[]));

-- ============ INVITES ============
CREATE TABLE public.user_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  role public.app_role NOT NULL,
  department TEXT,
  full_name TEXT,
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '14 days'),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.user_invites (lower(email)) WHERE accepted_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_invites TO authenticated;
GRANT ALL ON public.user_invites TO service_role;
ALTER TABLE public.user_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invites_admin_manage" ON public.user_invites FOR ALL
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','admin']::public.app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','admin']::public.app_role[]));

-- ============ SUPPLIERS ============
CREATE TABLE public.suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.suppliers TO authenticated;
GRANT ALL ON public.suppliers TO service_role;
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "suppliers_read_all" ON public.suppliers FOR SELECT TO authenticated USING (true);
CREATE POLICY "suppliers_write_ops" ON public.suppliers FOR ALL
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager','procurement','inventory_officer']::public.app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager','procurement','inventory_officer']::public.app_role[]));

-- ============ INVENTORY ITEMS ============
CREATE TABLE public.inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category public.inventory_category NOT NULL,
  unit TEXT NOT NULL DEFAULT 'unit',
  supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  purchase_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  min_level NUMERIC(14,3) NOT NULL DEFAULT 0,
  reorder_level NUMERIC(14,3) NOT NULL DEFAULT 0,
  location TEXT,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.inventory_items (category);
CREATE INDEX ON public.inventory_items (name);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_items TO authenticated;
GRANT ALL ON public.inventory_items TO service_role;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "items_read_all" ON public.inventory_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "items_write_ops" ON public.inventory_items FOR ALL
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager','inventory_officer']::public.app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager','inventory_officer']::public.app_role[]));

-- ============ INVENTORY BATCHES (for expiry tracking) ============
CREATE TABLE public.inventory_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  batch_number TEXT NOT NULL,
  expiry_date DATE,
  quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.inventory_batches (item_id);
CREATE INDEX ON public.inventory_batches (expiry_date);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_batches TO authenticated;
GRANT ALL ON public.inventory_batches TO service_role;
ALTER TABLE public.inventory_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "batches_read_all" ON public.inventory_batches FOR SELECT TO authenticated USING (true);
CREATE POLICY "batches_write_ops" ON public.inventory_batches FOR ALL
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager','inventory_officer','production']::public.app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager','inventory_officer','production']::public.app_role[]));

-- ============ INVENTORY MOVEMENTS ============
CREATE TABLE public.inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES public.inventory_batches(id) ON DELETE SET NULL,
  type public.movement_type NOT NULL,
  quantity NUMERIC(14,3) NOT NULL,
  reason TEXT,
  related_production_batch UUID,
  performed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.inventory_movements (item_id, created_at DESC);
CREATE INDEX ON public.inventory_movements (created_at DESC);
GRANT SELECT, INSERT ON public.inventory_movements TO authenticated;
GRANT ALL ON public.inventory_movements TO service_role;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "movements_read_all" ON public.inventory_movements FOR SELECT TO authenticated USING (true);
CREATE POLICY "movements_insert_ops" ON public.inventory_movements FOR INSERT
  TO authenticated
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager','inventory_officer','production']::public.app_role[]));

-- ============ PRODUCTION ============
CREATE TABLE public.production_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number TEXT NOT NULL UNIQUE,
  product_item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  quantity_produced NUMERIC(14,3) NOT NULL,
  produced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status public.batch_status NOT NULL DEFAULT 'completed',
  qc_notes TEXT,
  staff_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.production_batches TO authenticated;
GRANT ALL ON public.production_batches TO service_role;
ALTER TABLE public.production_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prod_read_all" ON public.production_batches FOR SELECT TO authenticated USING (true);
CREATE POLICY "prod_write_ops" ON public.production_batches FOR ALL
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager','production']::public.app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager','production']::public.app_role[]));

CREATE TABLE public.production_consumption (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_batch_id UUID NOT NULL REFERENCES public.production_batches(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  quantity_used NUMERIC(14,3) NOT NULL
);
GRANT SELECT, INSERT ON public.production_consumption TO authenticated;
GRANT ALL ON public.production_consumption TO service_role;
ALTER TABLE public.production_consumption ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cons_read_all" ON public.production_consumption FOR SELECT TO authenticated USING (true);
CREATE POLICY "cons_write_ops" ON public.production_consumption FOR ALL
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager','production']::public.app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager','production']::public.app_role[]));

-- ============ NOTIFICATIONS ============
CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  level public.notification_level NOT NULL DEFAULT 'info',
  link TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.notifications (user_id, created_at DESC);
GRANT SELECT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notif_read_self_or_broadcast" ON public.notifications FOR SELECT
  TO authenticated USING (user_id IS NULL OR user_id = auth.uid());
CREATE POLICY "notif_update_self" ON public.notifications FOR UPDATE
  TO authenticated USING (user_id = auth.uid());

-- ============ ANNOUNCEMENTS ============
CREATE TABLE public.announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.announcements TO authenticated;
GRANT ALL ON public.announcements TO service_role;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ann_read_all" ON public.announcements FOR SELECT TO authenticated USING (true);
CREATE POLICY "ann_write_admin" ON public.announcements FOR ALL
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management']::public.app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management']::public.app_role[]));

-- ============ AUDIT LOG ============
CREATE TABLE public.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  previous_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.audit_log (created_at DESC);
CREATE INDEX ON public.audit_log (entity, entity_id);
GRANT SELECT, INSERT ON public.audit_log TO authenticated;
GRANT ALL ON public.audit_log TO service_role;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_read_mgmt" ON public.audit_log FOR SELECT
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','admin','management','operations_manager']::public.app_role[]));
CREATE POLICY "audit_insert_any" ON public.audit_log FOR INSERT
  TO authenticated WITH CHECK (user_id = auth.uid());

-- ============ TRIGGERS ============

-- updated_at helper
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_items_updated BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- New user handler: create profile; if first user ever, grant super_admin; else check invite
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite public.user_invites%ROWTYPE;
  v_role_count INT;
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));

  SELECT COUNT(*) INTO v_role_count FROM public.user_roles;

  IF v_role_count = 0 THEN
    -- First user becomes super admin
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'super_admin');
  ELSE
    -- Check for an unaccepted invite matching this email
    SELECT * INTO v_invite FROM public.user_invites
      WHERE lower(email) = lower(NEW.email) AND accepted_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
      INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, v_invite.role)
        ON CONFLICT DO NOTHING;
      UPDATE public.user_invites SET accepted_at = now() WHERE id = v_invite.id;
      IF v_invite.department IS NOT NULL OR v_invite.full_name IS NOT NULL THEN
        UPDATE public.profiles SET
          department = COALESCE(v_invite.department, department),
          full_name = COALESCE(v_invite.full_name, full_name)
        WHERE id = NEW.id;
      END IF;
    ELSE
      -- No invite: readonly by default
      INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'readonly');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Movement -> adjust inventory quantity + emit low-stock notifications
CREATE OR REPLACE FUNCTION public.apply_movement()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_delta NUMERIC;
  v_item public.inventory_items%ROWTYPE;
  v_new_qty NUMERIC;
  v_recipient RECORD;
BEGIN
  -- Sign convention: additions positive, removals negative
  IF NEW.type IN ('stock_in','adjustment','production_output') THEN
    v_delta := NEW.quantity;
  ELSIF NEW.type IN ('stock_out','damaged','expired','wastage','production_consume') THEN
    v_delta := -1 * abs(NEW.quantity);
  ELSIF NEW.type = 'transfer' THEN
    v_delta := 0; -- transfers do not net-change total
  ELSE
    v_delta := NEW.quantity;
  END IF;

  UPDATE public.inventory_items
    SET quantity = quantity + v_delta, updated_at = now()
    WHERE id = NEW.item_id
    RETURNING * INTO v_item;

  v_new_qty := v_item.quantity;

  -- Low stock notification when crossing below min_level
  IF v_new_qty <= v_item.min_level AND v_delta < 0 THEN
    FOR v_recipient IN
      SELECT DISTINCT ur.user_id FROM public.user_roles ur
      WHERE ur.role IN ('super_admin','management','operations_manager','inventory_officer','procurement')
    LOOP
      INSERT INTO public.notifications (user_id, title, body, level, link)
      VALUES (
        v_recipient.user_id,
        CASE WHEN v_new_qty <= 0 THEN 'Out of stock: ' || v_item.name
             ELSE 'Low stock: ' || v_item.name END,
        v_item.sku || ' — ' || v_new_qty::TEXT || ' ' || v_item.unit || ' remaining (min ' || v_item.min_level::TEXT || ')',
        CASE WHEN v_new_qty <= 0 THEN 'critical'::public.notification_level
             ELSE 'warn'::public.notification_level END,
        '/inventory/' || v_item.id::TEXT
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_apply_movement
AFTER INSERT ON public.inventory_movements
FOR EACH ROW EXECUTE FUNCTION public.apply_movement();

-- Production batch -> emit movements for consumption + output
CREATE OR REPLACE FUNCTION public.record_production(
  _product_item_id UUID,
  _quantity NUMERIC,
  _batch_number TEXT,
  _consumption JSONB,
  _qc_notes TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch_id UUID;
  v_row JSONB;
  v_item_id UUID;
  v_qty NUMERIC;
  v_current NUMERIC;
BEGIN
  -- Validate stock
  FOR v_row IN SELECT * FROM jsonb_array_elements(_consumption)
  LOOP
    v_item_id := (v_row->>'item_id')::UUID;
    v_qty := (v_row->>'quantity')::NUMERIC;
    SELECT quantity INTO v_current FROM public.inventory_items WHERE id = v_item_id;
    IF v_current IS NULL THEN
      RAISE EXCEPTION 'Ingredient % not found', v_item_id;
    END IF;
    IF v_current < v_qty THEN
      RAISE EXCEPTION 'Insufficient stock for item %: have %, need %', v_item_id, v_current, v_qty;
    END IF;
  END LOOP;

  INSERT INTO public.production_batches (batch_number, product_item_id, quantity_produced, qc_notes, staff_id, status)
  VALUES (_batch_number, _product_item_id, _quantity, _qc_notes, auth.uid(), 'completed')
  RETURNING id INTO v_batch_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_consumption)
  LOOP
    v_item_id := (v_row->>'item_id')::UUID;
    v_qty := (v_row->>'quantity')::NUMERIC;
    INSERT INTO public.production_consumption (production_batch_id, item_id, quantity_used)
    VALUES (v_batch_id, v_item_id, v_qty);
    INSERT INTO public.inventory_movements (item_id, type, quantity, reason, related_production_batch, performed_by)
    VALUES (v_item_id, 'production_consume', v_qty, 'Consumed by batch ' || _batch_number, v_batch_id, auth.uid());
  END LOOP;

  INSERT INTO public.inventory_movements (item_id, type, quantity, reason, related_production_batch, performed_by)
  VALUES (_product_item_id, 'production_output', _quantity, 'Produced by batch ' || _batch_number, v_batch_id, auth.uid());

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'production.recorded', 'production_batches', v_batch_id::TEXT,
    jsonb_build_object('batch_number', _batch_number, 'quantity', _quantity, 'product_item_id', _product_item_id));

  RETURN v_batch_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_production(UUID, NUMERIC, TEXT, JSONB, TEXT) TO authenticated;

-- Realtime for notifications
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

-- ============ SEED DEMO INVENTORY ============
INSERT INTO public.inventory_items (sku, name, category, unit, quantity, min_level, reorder_level, purchase_cost, location) VALUES
('FR-ORNG-01','Valencia Oranges','raw_material','kg',420,500,800,1.20,'Cold Room A'),
('FR-APPL-01','Gala Apples','raw_material','kg',2400,500,900,1.10,'Cold Room A'),
('FR-PINP-01','Golden Pineapples','raw_material','kg',180,200,400,2.50,'Cold Room B'),
('FR-BERR-01','Mixed Berries','raw_material','kg',95,150,300,4.80,'Freezer 1'),
('SW-AGAV-01','Agave Nectar','raw_material','L',800,300,600,3.50,'Dry Store'),
('WT-DIST-01','Distilled Water','raw_material','L',5200,2000,4000,0.05,'Tank 1'),
('PK-BOT-500','500ml PET Bottles','packaging','unit',12000,3000,6000,0.08,'Warehouse A'),
('PK-CAP-STD','Standard Caps','packaging','unit',14500,3000,6000,0.02,'Warehouse A'),
('PK-LBL-ORNG','Orange Juice Labels','packaging','unit',4200,2000,4000,0.03,'Warehouse A'),
('PK-CRT-12','12-Bottle Carton','packaging','unit',680,300,600,0.45,'Warehouse B'),
('CN-GLV-NIT','Nitrile Gloves','consumable','pair',480,200,400,0.15,'Supply Room'),
('CN-CLNR-01','Line Cleaning Solution','consumable','L',22,10,25,8.50,'Supply Room'),
('FG-OJ-500','Fresh Orange Juice 500ml','finished_good','unit',340,100,300,0,'Finished Storage'),
('FG-AJ-500','Apple Juice 500ml','finished_good','unit',1200,100,300,0,'Finished Storage')
ON CONFLICT (sku) DO NOTHING;
