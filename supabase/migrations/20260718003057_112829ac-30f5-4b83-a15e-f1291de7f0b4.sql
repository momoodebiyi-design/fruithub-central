
-- 1) BOOTSTRAP CHECK (secure)
CREATE OR REPLACE FUNCTION public.bootstrap_allowed()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles)
$$;
REVOKE ALL ON FUNCTION public.bootstrap_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bootstrap_allowed() TO anon, authenticated;

-- 2) HARDENED handle_new_user: require valid invite unless bootstrap
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_invite public.user_invites%ROWTYPE;
  v_role_count INT;
BEGIN
  SELECT COUNT(*) INTO v_role_count FROM public.user_roles;

  IF v_role_count = 0 THEN
    INSERT INTO public.profiles (id, email, full_name)
    VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'super_admin');
    RETURN NEW;
  END IF;

  SELECT * INTO v_invite FROM public.user_invites
    WHERE lower(email) = lower(NEW.email)
      AND accepted_at IS NULL
      AND expires_at > now()
    ORDER BY created_at DESC LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sign-up requires a valid invitation. Contact an administrator.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, department)
  VALUES (NEW.id, NEW.email,
          COALESCE(v_invite.full_name, NEW.raw_user_meta_data->>'full_name', NEW.email),
          v_invite.department);
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, v_invite.role)
    ON CONFLICT DO NOTHING;
  UPDATE public.user_invites SET accepted_at = now() WHERE id = v_invite.id;
  RETURN NEW;
END;
$$;

-- 3) Add Shop 1 location for pilot (idempotent)
INSERT INTO public.locations (location_id, name, location_type, is_default, status)
SELECT 'LOC0002', 'Shop 1', 'shop', false, 'active'
WHERE NOT EXISTS (SELECT 1 FROM public.locations WHERE name = 'Shop 1');

-- 4) Location-aware balance view
CREATE OR REPLACE VIEW public.v_item_location_stock
WITH (security_invoker = true) AS
SELECT
  m.item_id,
  m.location_id,
  SUM(
    CASE
      WHEN m.type IN ('stock_in','opening_balance','receipt','adjustment_in','production_output') THEN abs(m.quantity)
      WHEN m.type IN ('stock_out','sale','damaged','expired','wastage','production_consume','adjustment_out') THEN -abs(m.quantity)
      WHEN m.type = 'adjustment' THEN m.quantity
      ELSE 0
    END
  )::numeric AS on_hand
FROM public.inventory_movements m
WHERE m.location_id IS NOT NULL
GROUP BY m.item_id, m.location_id;

GRANT SELECT ON public.v_item_location_stock TO authenticated;

-- 5) Safe manual movement RPC (blocks transfer, requires location, validates stock-out)
CREATE OR REPLACE FUNCTION public.record_manual_movement(
  _item_id uuid,
  _location_id uuid,
  _type movement_type,
  _quantity numeric,
  _reason text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_current numeric;
  v_delta numeric;
  v_id uuid;
BEGIN
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','management','operations_manager','inventory_officer','production']::app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to record stock movements';
  END IF;

  IF _location_id IS NULL THEN
    RAISE EXCEPTION 'A stock location is required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE id = _location_id AND status = 'active') THEN
    RAISE EXCEPTION 'Unknown or inactive location';
  END IF;

  IF _type NOT IN ('stock_in','stock_out','adjustment','adjustment_in','adjustment_out',
                   'damaged','expired','wastage','opening_balance','receipt') THEN
    RAISE EXCEPTION 'Movement type % is not allowed for manual entry. Use the dedicated workflow.', _type;
  END IF;

  IF _type = 'adjustment' THEN
    v_delta := _quantity;
  ELSIF _type IN ('stock_in','opening_balance','receipt','adjustment_in') THEN
    IF _quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    v_delta := abs(_quantity);
  ELSE
    IF _quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    v_delta := -abs(_quantity);
  END IF;

  IF v_delta < 0 THEN
    SELECT COALESCE(on_hand,0) INTO v_current
      FROM public.v_item_location_stock
      WHERE item_id = _item_id AND location_id = _location_id;
    v_current := COALESCE(v_current, 0);
    IF v_current + v_delta < 0 THEN
      RAISE EXCEPTION 'Insufficient stock at location: have %, requested %', v_current, abs(v_delta);
    END IF;
  END IF;

  INSERT INTO public.inventory_movements
    (item_id, type, quantity, reason, location_id, source, performed_by)
  VALUES
    (_item_id, _type,
     CASE WHEN _type = 'adjustment' THEN _quantity ELSE abs(_quantity) END,
     _reason, _location_id, 'manual', auth.uid())
  RETURNING id INTO v_id;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'movement.manual', 'inventory_movements', v_id::text,
    jsonb_build_object('item_id',_item_id,'location_id',_location_id,'type',_type,'quantity',_quantity,'reason',_reason));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_manual_movement(uuid,uuid,movement_type,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_manual_movement(uuid,uuid,movement_type,numeric,text) TO authenticated;

-- 6) Location-aware stock-count adjustment RPC
CREATE OR REPLACE FUNCTION public.record_location_stock_count(
  _item_id uuid,
  _location_id uuid,
  _physical_qty numeric,
  _reason text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_system numeric;
  v_delta numeric;
  v_id uuid;
BEGIN
  IF NOT public.has_any_role(auth.uid(),
      ARRAY['super_admin','management','operations_manager','inventory_officer']::app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to record stock counts';
  END IF;
  IF _location_id IS NULL THEN RAISE EXCEPTION 'Location is required'; END IF;
  IF _physical_qty < 0 THEN RAISE EXCEPTION 'Physical count must be >= 0'; END IF;
  IF COALESCE(btrim(_reason),'') = '' THEN RAISE EXCEPTION 'Reason is required'; END IF;

  SELECT COALESCE(on_hand,0) INTO v_system
    FROM public.v_item_location_stock
    WHERE item_id = _item_id AND location_id = _location_id;
  v_system := COALESCE(v_system, 0);
  v_delta := _physical_qty - v_system;

  IF v_delta = 0 THEN RETURN NULL; END IF;

  INSERT INTO public.inventory_movements
    (item_id, type, quantity, reason, location_id, source, performed_by)
  VALUES
    (_item_id, 'adjustment', v_delta,
     'Stock count: physical ' || _physical_qty || ' vs system ' || v_system || ' — ' || _reason,
     _location_id, 'stock_count', auth.uid())
  RETURNING id INTO v_id;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'stock.count_adjustment', 'inventory_movements', v_id::text,
    jsonb_build_object('item_id',_item_id,'location_id',_location_id,'physical',_physical_qty,'system',v_system,'delta',v_delta,'reason',_reason));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_location_stock_count(uuid,uuid,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_location_stock_count(uuid,uuid,numeric,text) TO authenticated;
