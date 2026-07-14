
-- SHOPS
CREATE TABLE public.shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  location TEXT,
  manager_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  contact_phone TEXT,
  contact_email TEXT,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shops TO authenticated;
GRANT ALL ON public.shops TO service_role;
ALTER TABLE public.shops ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone signed in can view shops" ON public.shops FOR SELECT TO authenticated USING (true);
CREATE POLICY "Managers can insert shops" ON public.shops FOR INSERT TO authenticated
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager']::app_role[]));
CREATE POLICY "Managers can update shops" ON public.shops FOR UPDATE TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager']::app_role[]));
CREATE POLICY "Managers can delete shops" ON public.shops FOR DELETE TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management']::app_role[]));
CREATE TRIGGER trg_shops_updated_at BEFORE UPDATE ON public.shops
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- DISPATCH STATUS
CREATE TYPE public.dispatch_status AS ENUM ('draft','dispatched','received','reconciled','cancelled');

CREATE TABLE public.dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  vehicle TEXT,
  notes TEXT,
  status public.dispatch_status NOT NULL DEFAULT 'dispatched',
  dispatched_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  received_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dispatches TO authenticated;
GRANT ALL ON public.dispatches TO service_role;
ALTER TABLE public.dispatches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Signed in can view dispatches" ON public.dispatches FOR SELECT TO authenticated USING (true);
CREATE POLICY "Ops can insert dispatches" ON public.dispatches FOR INSERT TO authenticated
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]));
CREATE POLICY "Ops can update dispatches" ON public.dispatches FOR UPDATE TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]));
CREATE POLICY "Managers can delete dispatches" ON public.dispatches FOR DELETE TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management']::app_role[]));
CREATE TRIGGER trg_dispatches_updated_at BEFORE UPDATE ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.dispatch_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id UUID NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  quantity_dispatched NUMERIC NOT NULL CHECK (quantity_dispatched > 0),
  quantity_returned NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dispatch_lines TO authenticated;
GRANT ALL ON public.dispatch_lines TO service_role;
ALTER TABLE public.dispatch_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Signed in can view dispatch lines" ON public.dispatch_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "Ops can insert dispatch lines" ON public.dispatch_lines FOR INSERT TO authenticated
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]));
CREATE POLICY "Ops can update dispatch lines" ON public.dispatch_lines FOR UPDATE TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]));
CREATE POLICY "Ops can delete dispatch lines" ON public.dispatch_lines FOR DELETE TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]));

CREATE INDEX idx_dispatch_lines_dispatch ON public.dispatch_lines(dispatch_id);
CREATE INDEX idx_dispatch_lines_item ON public.dispatch_lines(item_id);
CREATE INDEX idx_dispatches_shop ON public.dispatches(shop_id);

-- Add shop/dispatch refs to inventory_movements
ALTER TABLE public.inventory_movements
  ADD COLUMN dispatch_id UUID REFERENCES public.dispatches(id) ON DELETE SET NULL,
  ADD COLUMN to_shop_id UUID REFERENCES public.shops(id) ON DELETE SET NULL,
  ADD COLUMN from_shop_id UUID REFERENCES public.shops(id) ON DELETE SET NULL;

CREATE INDEX idx_movements_dispatch ON public.inventory_movements(dispatch_id);
CREATE INDEX idx_movements_to_shop ON public.inventory_movements(to_shop_id);
CREATE INDEX idx_movements_from_shop ON public.inventory_movements(from_shop_id);

-- STOCK REQUESTS (approval workflow)
CREATE TYPE public.stock_request_status AS ENUM ('pending','approved','rejected','fulfilled','cancelled');

CREATE TABLE public.stock_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  purpose TEXT NOT NULL,
  destination_shop_id UUID REFERENCES public.shops(id) ON DELETE SET NULL,
  status public.stock_request_status NOT NULL DEFAULT 'pending',
  reviewer_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  review_notes TEXT,
  reviewed_at TIMESTAMPTZ,
  fulfilled_movement_id UUID REFERENCES public.inventory_movements(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_requests TO authenticated;
GRANT ALL ON public.stock_requests TO service_role;
ALTER TABLE public.stock_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own requests or reviewers see all" ON public.stock_requests FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[])
  );
CREATE POLICY "Signed in can create requests" ON public.stock_requests FOR INSERT TO authenticated
  WITH CHECK (requested_by = auth.uid());
CREATE POLICY "Requesters cancel or reviewers update" ON public.stock_requests FOR UPDATE TO authenticated
  USING (
    (requested_by = auth.uid() AND status = 'pending')
    OR public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[])
  );
CREATE POLICY "Managers can delete requests" ON public.stock_requests FOR DELETE TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','management']::app_role[]));

CREATE TRIGGER trg_stock_requests_updated_at BEFORE UPDATE ON public.stock_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_stock_requests_status ON public.stock_requests(status);
CREATE INDEX idx_stock_requests_requester ON public.stock_requests(requested_by);

-- RPC: create dispatch atomically
CREATE OR REPLACE FUNCTION public.create_dispatch(
  _shop_id UUID,
  _reference TEXT,
  _vehicle TEXT,
  _notes TEXT,
  _lines JSONB
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dispatch_id UUID;
  v_row JSONB;
  v_item_id UUID;
  v_qty NUMERIC;
  v_current NUMERIC;
  v_item_name TEXT;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to create dispatches';
  END IF;

  -- Validate stock levels
  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_item_id := (v_row->>'item_id')::UUID;
    v_qty := (v_row->>'quantity')::NUMERIC;
    SELECT quantity, name INTO v_current, v_item_name FROM public.inventory_items WHERE id = v_item_id;
    IF v_current IS NULL THEN RAISE EXCEPTION 'Item % not found', v_item_id; END IF;
    IF v_current < v_qty THEN
      RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_item_name, v_current, v_qty;
    END IF;
  END LOOP;

  INSERT INTO public.dispatches (reference, shop_id, vehicle, notes, status, dispatched_by)
  VALUES (_reference, _shop_id, _vehicle, _notes, 'dispatched', auth.uid())
  RETURNING id INTO v_dispatch_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_item_id := (v_row->>'item_id')::UUID;
    v_qty := (v_row->>'quantity')::NUMERIC;

    INSERT INTO public.dispatch_lines (dispatch_id, item_id, quantity_dispatched)
    VALUES (v_dispatch_id, v_item_id, v_qty);

    INSERT INTO public.inventory_movements
      (item_id, type, quantity, reason, dispatch_id, to_shop_id, performed_by)
    VALUES
      (v_item_id, 'stock_out', v_qty, 'Dispatch ' || _reference, v_dispatch_id, _shop_id, auth.uid());
  END LOOP;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'dispatch.created', 'dispatches', v_dispatch_id::TEXT,
    jsonb_build_object('reference', _reference, 'shop_id', _shop_id, 'lines', _lines));

  RETURN v_dispatch_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_dispatch(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_dispatch(UUID, TEXT, TEXT, TEXT, JSONB) TO authenticated;

-- RPC: record shop return
CREATE OR REPLACE FUNCTION public.record_shop_return(
  _dispatch_id UUID,
  _lines JSONB,
  _reason TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB;
  v_line_id UUID;
  v_item_id UUID;
  v_qty NUMERIC;
  v_shop_id UUID;
  v_reference TEXT;
  v_remaining NUMERIC;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to record shop returns';
  END IF;

  SELECT shop_id, reference INTO v_shop_id, v_reference FROM public.dispatches WHERE id = _dispatch_id;
  IF v_shop_id IS NULL THEN RAISE EXCEPTION 'Dispatch not found'; END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_line_id := (v_row->>'line_id')::UUID;
    v_qty := (v_row->>'quantity')::NUMERIC;
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT item_id, (quantity_dispatched - quantity_returned)
      INTO v_item_id, v_remaining
    FROM public.dispatch_lines WHERE id = v_line_id AND dispatch_id = _dispatch_id;
    IF v_item_id IS NULL THEN RAISE EXCEPTION 'Dispatch line % not found', v_line_id; END IF;
    IF v_qty > v_remaining THEN
      RAISE EXCEPTION 'Return quantity % exceeds remaining % on line', v_qty, v_remaining;
    END IF;

    UPDATE public.dispatch_lines
      SET quantity_returned = quantity_returned + v_qty
      WHERE id = v_line_id;

    INSERT INTO public.inventory_movements
      (item_id, type, quantity, reason, dispatch_id, from_shop_id, performed_by)
    VALUES
      (v_item_id, 'stock_in', v_qty,
       COALESCE(_reason, 'Return from shop') || ' (' || v_reference || ')',
       _dispatch_id, v_shop_id, auth.uid());
  END LOOP;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'dispatch.return_recorded', 'dispatches', _dispatch_id::TEXT,
    jsonb_build_object('lines', _lines, 'reason', _reason));
END;
$$;
REVOKE ALL ON FUNCTION public.record_shop_return(UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_shop_return(UUID, JSONB, TEXT) TO authenticated;

-- RPC: approve stock request => creates a movement
CREATE OR REPLACE FUNCTION public.approve_stock_request(
  _request_id UUID,
  _notes TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.stock_requests%ROWTYPE;
  v_current NUMERIC;
  v_movement_id UUID;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to approve requests';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = _request_id;
  IF v_req.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'Request is not pending'; END IF;

  SELECT quantity INTO v_current FROM public.inventory_items WHERE id = v_req.item_id;
  IF v_current < v_req.quantity THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_current, v_req.quantity;
  END IF;

  INSERT INTO public.inventory_movements (item_id, type, quantity, reason, to_shop_id, performed_by)
  VALUES (v_req.item_id, 'stock_out', v_req.quantity,
    'Stock request approved: ' || v_req.purpose,
    v_req.destination_shop_id, auth.uid())
  RETURNING id INTO v_movement_id;

  UPDATE public.stock_requests
    SET status = 'fulfilled',
        reviewer_id = auth.uid(),
        review_notes = _notes,
        reviewed_at = now(),
        fulfilled_movement_id = v_movement_id
    WHERE id = _request_id;

  INSERT INTO public.notifications (user_id, title, body, level, link)
  VALUES (v_req.requested_by, 'Stock request approved',
    'Your request for ' || v_req.quantity::TEXT || ' unit(s) was approved.',
    'info', '/requests');

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'stock_request.approved', 'stock_requests', _request_id::TEXT,
    jsonb_build_object('movement_id', v_movement_id));

  RETURN v_movement_id;
END;
$$;
REVOKE ALL ON FUNCTION public.approve_stock_request(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_stock_request(UUID, TEXT) TO authenticated;

-- RPC: reject stock request
CREATE OR REPLACE FUNCTION public.reject_stock_request(
  _request_id UUID,
  _notes TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.stock_requests%ROWTYPE;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = _request_id;
  IF v_req.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'Request is not pending'; END IF;

  UPDATE public.stock_requests
    SET status = 'rejected', reviewer_id = auth.uid(), review_notes = _notes, reviewed_at = now()
    WHERE id = _request_id;

  INSERT INTO public.notifications (user_id, title, body, level, link)
  VALUES (v_req.requested_by, 'Stock request rejected',
    COALESCE(_notes, 'Your stock request was rejected.'), 'warn', '/requests');

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'stock_request.rejected', 'stock_requests', _request_id::TEXT,
    jsonb_build_object('notes', _notes));
END;
$$;
REVOKE ALL ON FUNCTION public.reject_stock_request(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_stock_request(UUID, TEXT) TO authenticated;

-- Notify reviewers when a new request comes in
CREATE OR REPLACE FUNCTION public.notify_reviewers_on_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recipient RECORD;
  v_item_name TEXT;
  v_requester_name TEXT;
BEGIN
  SELECT name INTO v_item_name FROM public.inventory_items WHERE id = NEW.item_id;
  SELECT COALESCE(full_name, email) INTO v_requester_name FROM public.profiles WHERE id = NEW.requested_by;
  FOR v_recipient IN
    SELECT DISTINCT ur.user_id FROM public.user_roles ur
    WHERE ur.role IN ('super_admin','management','operations_manager','inventory_officer')
  LOOP
    INSERT INTO public.notifications (user_id, title, body, level, link)
    VALUES (v_recipient.user_id,
      'New stock request',
      v_requester_name || ' requested ' || NEW.quantity::TEXT || ' × ' || v_item_name,
      'info', '/requests');
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_notify_reviewers_on_request
  AFTER INSERT ON public.stock_requests
  FOR EACH ROW EXECUTE FUNCTION public.notify_reviewers_on_request();
