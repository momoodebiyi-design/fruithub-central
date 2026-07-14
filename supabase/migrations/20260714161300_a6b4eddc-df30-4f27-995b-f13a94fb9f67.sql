
-- profiles.shop_id
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES public.shops(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS profiles_shop_id_idx ON public.profiles(shop_id);

-- Clients
CREATE TABLE IF NOT EXISTS public.clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clients TO authenticated;
GRANT ALL ON public.clients TO service_role;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY clients_read_authenticated ON public.clients FOR SELECT TO authenticated USING (true);
CREATE POLICY clients_write_managers ON public.clients FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','sales']::app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','sales']::app_role[]));
CREATE TRIGGER clients_set_updated_at BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Dispatches destination + invoice
ALTER TABLE public.dispatches
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.clients(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS invoice_url TEXT,
  ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE public.dispatches ALTER COLUMN shop_id DROP NOT NULL;
ALTER TABLE public.dispatches DROP CONSTRAINT IF EXISTS dispatches_destination_chk;
ALTER TABLE public.dispatches ADD CONSTRAINT dispatches_destination_chk
  CHECK ((shop_id IS NOT NULL)::int + (client_id IS NOT NULL)::int = 1);
ALTER TABLE public.inventory_movements
  ADD COLUMN IF NOT EXISTS to_client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS from_client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL;

-- Shop assortments
CREATE TABLE IF NOT EXISTS public.shop_assortments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shop_id, item_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shop_assortments TO authenticated;
GRANT ALL ON public.shop_assortments TO service_role;
ALTER TABLE public.shop_assortments ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_assortments_read ON public.shop_assortments FOR SELECT TO authenticated USING (true);
CREATE POLICY shop_assortments_write_managers ON public.shop_assortments FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]));
CREATE INDEX IF NOT EXISTS shop_assortments_shop_idx ON public.shop_assortments(shop_id);

-- Shop stock counts
DO $$ BEGIN CREATE TYPE public.stock_count_type AS ENUM ('opening','closing');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.stock_count_status AS ENUM ('draft','submitted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.shop_stock_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  count_date DATE NOT NULL,
  count_type public.stock_count_type NOT NULL,
  status public.stock_count_status NOT NULL DEFAULT 'draft',
  notes TEXT,
  submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shop_id, count_date, count_type)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shop_stock_counts TO authenticated;
GRANT ALL ON public.shop_stock_counts TO service_role;
ALTER TABLE public.shop_stock_counts ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_stock_counts_read ON public.shop_stock_counts FOR SELECT TO authenticated USING (
  public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer','production','procurement']::app_role[])
  OR shop_id = (SELECT p.shop_id FROM public.profiles p WHERE p.id = auth.uid())
);
CREATE POLICY shop_stock_counts_insert ON public.shop_stock_counts FOR INSERT TO authenticated WITH CHECK (
  public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[])
  OR (public.has_role(auth.uid(), 'shop_supervisor')
      AND shop_id = (SELECT p.shop_id FROM public.profiles p WHERE p.id = auth.uid()))
);
CREATE POLICY shop_stock_counts_update ON public.shop_stock_counts FOR UPDATE TO authenticated USING (
  public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[])
  OR (public.has_role(auth.uid(), 'shop_supervisor')
      AND shop_id = (SELECT p.shop_id FROM public.profiles p WHERE p.id = auth.uid())
      AND status = 'draft')
);
CREATE TRIGGER shop_stock_counts_set_updated_at BEFORE UPDATE ON public.shop_stock_counts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.shop_stock_count_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id UUID NOT NULL REFERENCES public.shop_stock_counts(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  quantity_counted NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (count_id, item_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shop_stock_count_lines TO authenticated;
GRANT ALL ON public.shop_stock_count_lines TO service_role;
ALTER TABLE public.shop_stock_count_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_stock_count_lines_read ON public.shop_stock_count_lines FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.shop_stock_counts c WHERE c.id = count_id AND (
    public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer','production','procurement']::app_role[])
    OR c.shop_id = (SELECT p.shop_id FROM public.profiles p WHERE p.id = auth.uid())
  ))
);
CREATE POLICY shop_stock_count_lines_write ON public.shop_stock_count_lines FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.shop_stock_counts c WHERE c.id = count_id AND (
      public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[])
      OR (public.has_role(auth.uid(), 'shop_supervisor')
          AND c.shop_id = (SELECT p.shop_id FROM public.profiles p WHERE p.id = auth.uid())
          AND c.status = 'draft')
    ))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.shop_stock_counts c WHERE c.id = count_id AND (
      public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[])
      OR (public.has_role(auth.uid(), 'shop_supervisor')
          AND c.shop_id = (SELECT p.shop_id FROM public.profiles p WHERE p.id = auth.uid())
          AND c.status = 'draft')
    ))
  );

-- Storage policies for dispatch-invoices
CREATE POLICY dispatch_invoices_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'dispatch-invoices');
CREATE POLICY dispatch_invoices_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'dispatch-invoices'
    AND public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer','sales']::app_role[]));
CREATE POLICY dispatch_invoices_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'dispatch-invoices'
    AND public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer','sales']::app_role[]));

-- Updated create_dispatch RPC
DROP FUNCTION IF EXISTS public.create_dispatch(uuid, text, text, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_dispatch(
  _shop_id UUID, _client_id UUID, _reference TEXT, _vehicle TEXT, _notes TEXT,
  _invoice_url TEXT, _invoice_number TEXT, _lines JSONB
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_dispatch_id UUID; v_row JSONB; v_item_id UUID; v_qty NUMERIC;
  v_current NUMERIC; v_item_name TEXT; v_destination_label TEXT;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer','sales']::app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to create dispatches';
  END IF;
  IF (_shop_id IS NOT NULL)::int + (_client_id IS NOT NULL)::int <> 1 THEN
    RAISE EXCEPTION 'Dispatch must have exactly one destination (shop or client)';
  END IF;
  IF _shop_id IS NOT NULL THEN
    SELECT 'shop ' || name INTO v_destination_label FROM public.shops WHERE id = _shop_id;
  ELSE
    SELECT 'client ' || name INTO v_destination_label FROM public.clients WHERE id = _client_id;
  END IF;
  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_item_id := (v_row->>'item_id')::UUID;
    v_qty := (v_row->>'quantity')::NUMERIC;
    SELECT quantity, name INTO v_current, v_item_name FROM public.inventory_items WHERE id = v_item_id;
    IF v_current IS NULL THEN RAISE EXCEPTION 'Item % not found', v_item_id; END IF;
    IF v_current < v_qty THEN RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_item_name, v_current, v_qty; END IF;
  END LOOP;
  INSERT INTO public.dispatches (reference, shop_id, client_id, vehicle, notes, invoice_url, invoice_number, status, dispatched_by)
  VALUES (_reference, _shop_id, _client_id, _vehicle, _notes, _invoice_url, _invoice_number, 'dispatched', auth.uid())
  RETURNING id INTO v_dispatch_id;
  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_item_id := (v_row->>'item_id')::UUID;
    v_qty := (v_row->>'quantity')::NUMERIC;
    INSERT INTO public.dispatch_lines (dispatch_id, item_id, quantity_dispatched)
      VALUES (v_dispatch_id, v_item_id, v_qty);
    INSERT INTO public.inventory_movements
      (item_id, type, quantity, reason, dispatch_id, to_shop_id, to_client_id, performed_by)
    VALUES (v_item_id, 'stock_out', v_qty,
      'Dispatch ' || _reference || ' to ' || COALESCE(v_destination_label,''),
      v_dispatch_id, _shop_id, _client_id, auth.uid());
  END LOOP;
  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'dispatch.created', 'dispatches', v_dispatch_id::TEXT,
    jsonb_build_object('reference', _reference, 'shop_id', _shop_id, 'client_id', _client_id, 'lines', _lines));
  RETURN v_dispatch_id;
END; $$;

-- Submit stock count RPC
CREATE OR REPLACE FUNCTION public.submit_shop_stock_count(_count_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count public.shop_stock_counts%ROWTYPE;
  v_user_shop UUID; v_recipient RECORD; v_shop_name TEXT;
BEGIN
  SELECT * INTO v_count FROM public.shop_stock_counts WHERE id = _count_id;
  IF v_count.id IS NULL THEN RAISE EXCEPTION 'Count not found'; END IF;
  IF v_count.status = 'submitted' THEN RAISE EXCEPTION 'Already submitted'; END IF;
  SELECT shop_id INTO v_user_shop FROM public.profiles WHERE id = auth.uid();
  IF NOT (
    public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[])
    OR (public.has_role(auth.uid(),'shop_supervisor') AND v_count.shop_id = v_user_shop)
  ) THEN RAISE EXCEPTION 'Not authorized to submit this count'; END IF;
  UPDATE public.shop_stock_counts
    SET status = 'submitted', submitted_by = auth.uid(), submitted_at = now()
    WHERE id = _count_id;
  SELECT name INTO v_shop_name FROM public.shops WHERE id = v_count.shop_id;
  FOR v_recipient IN
    SELECT DISTINCT ur.user_id FROM public.user_roles ur
    WHERE ur.role IN ('super_admin','management','operations_manager','inventory_officer','production')
  LOOP
    INSERT INTO public.notifications (user_id, title, body, level, link)
    VALUES (v_recipient.user_id,
      v_count.count_type::TEXT || ' stock submitted — ' || v_shop_name,
      'Shop ' || v_shop_name || ' submitted ' || v_count.count_type::TEXT || ' count for ' || v_count.count_date::TEXT,
      'info', '/shop-counts/' || _count_id::TEXT);
  END LOOP;
  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'stock_count.submitted', 'shop_stock_counts', _count_id::TEXT,
    jsonb_build_object('shop_id', v_count.shop_id, 'date', v_count.count_date, 'type', v_count.count_type));
END; $$;

-- Suppliers contact info — restrict
DROP POLICY IF EXISTS suppliers_read_all ON public.suppliers;
CREATE POLICY suppliers_read_restricted ON public.suppliers FOR SELECT TO authenticated USING (
  public.has_any_role(auth.uid(),
    ARRAY['super_admin','admin','management','operations_manager','procurement']::app_role[])
);

-- Audit log — remove permissive insert
DROP POLICY IF EXISTS audit_insert_any ON public.audit_log;
REVOKE INSERT ON public.audit_log FROM authenticated;

-- Stock request supervisor scope
DROP POLICY IF EXISTS stock_requests_insert ON public.stock_requests;
CREATE POLICY stock_requests_insert ON public.stock_requests FOR INSERT TO authenticated WITH CHECK (
  requested_by = auth.uid()
  AND (
    NOT public.has_role(auth.uid(), 'shop_supervisor')
    OR destination_shop_id = (SELECT p.shop_id FROM public.profiles p WHERE p.id = auth.uid())
  )
);

-- Revoke EXECUTE from anon/public on SECURITY DEFINER fns
REVOKE ALL ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_any_role(uuid, app_role[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_production(uuid, numeric, text, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_dispatch(uuid, uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_shop_return(uuid, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_stock_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_stock_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_shop_stock_count(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_any_role(uuid, app_role[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_production(uuid, numeric, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_dispatch(uuid, uuid, text, text, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_shop_return(uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_stock_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_stock_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_shop_stock_count(uuid) TO authenticated;
