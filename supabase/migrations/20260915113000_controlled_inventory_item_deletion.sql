-- Inventory item retirement is intentionally a soft delete. Historical stock,
-- production, dispatch and purchasing records keep their stable item ID while
-- the item disappears from active operational lists.

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deletion_reason text;

-- Nobody may hard-delete an inventory item through PostgREST. The controlled
-- RPC below is the only supported delete path for authenticated users.
REVOKE DELETE ON public.inventory_items FROM authenticated;

CREATE OR REPLACE FUNCTION public.guard_inventory_item_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (
    NEW.is_active IS DISTINCT FROM OLD.is_active
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
    OR NEW.deletion_reason IS DISTINCT FROM OLD.deletion_reason
  ) AND current_setting('fruithub.inventory_item_lifecycle_rpc', true) IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'Inventory item status must be changed through the controlled deletion workflow';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_inventory_item_lifecycle ON public.inventory_items;
CREATE TRIGGER trg_guard_inventory_item_lifecycle
BEFORE UPDATE OF is_active, status, deleted_at, deleted_by, deletion_reason
ON public.inventory_items
FOR EACH ROW
EXECUTE FUNCTION public.guard_inventory_item_lifecycle();

CREATE OR REPLACE FUNCTION public.audit_inventory_item_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_previous jsonb;
  v_new jsonb;
  v_action text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := jsonb_build_object(
      'sku', NEW.sku,
      'name', NEW.name,
      'category', NEW.category,
      'unit', NEW.unit,
      'min_level', NEW.min_level,
      'reorder_level', NEW.reorder_level,
      'location', NEW.location,
      'is_active', NEW.is_active,
      'status', NEW.status
    );
    v_action := 'inventory_item.created';
  ELSE
    v_previous := jsonb_build_object(
      'sku', OLD.sku,
      'name', OLD.name,
      'category', OLD.category,
      'unit', OLD.unit,
      'min_level', OLD.min_level,
      'reorder_level', OLD.reorder_level,
      'location', OLD.location,
      'is_active', OLD.is_active,
      'status', OLD.status,
      'deleted_at', OLD.deleted_at,
      'deleted_by', OLD.deleted_by,
      'deletion_reason', OLD.deletion_reason
    );
    v_new := jsonb_build_object(
      'sku', NEW.sku,
      'name', NEW.name,
      'category', NEW.category,
      'unit', NEW.unit,
      'min_level', NEW.min_level,
      'reorder_level', NEW.reorder_level,
      'location', NEW.location,
      'is_active', NEW.is_active,
      'status', NEW.status,
      'deleted_at', NEW.deleted_at,
      'deleted_by', NEW.deleted_by,
      'deletion_reason', NEW.deletion_reason
    );

    -- Do not duplicate movement auditing when the legacy quantity cache or
    -- updated_at changes without an item-master change.
    IF v_previous = v_new THEN
      RETURN NEW;
    END IF;

    IF OLD.is_active AND NOT NEW.is_active AND NEW.deleted_at IS NOT NULL THEN
      v_action := 'inventory_item.deleted';
    ELSE
      v_action := 'inventory_item.updated';
    END IF;
  END IF;

  INSERT INTO public.audit_log (
    user_id,
    action,
    entity,
    entity_id,
    previous_value,
    new_value
  )
  VALUES (
    auth.uid(),
    v_action,
    'inventory_items',
    NEW.id::text,
    v_previous,
    v_new
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_inventory_item_change ON public.inventory_items;
CREATE TRIGGER trg_audit_inventory_item_change
AFTER INSERT OR UPDATE
ON public.inventory_items
FOR EACH ROW
EXECUTE FUNCTION public.audit_inventory_item_change();

CREATE OR REPLACE FUNCTION public.delete_inventory_item(
  _item_id uuid,
  _reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.inventory_items%ROWTYPE;
  v_on_hand numeric;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','admin','management']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Only Management or Admin can delete inventory items';
  END IF;

  IF _item_id IS NULL THEN
    RAISE EXCEPTION 'Inventory item is required';
  END IF;

  IF length(btrim(COALESCE(_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'A deletion reason of at least 5 characters is required';
  END IF;

  SELECT *
  INTO v_item
  FROM public.inventory_items
  WHERE id = _item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory item not found';
  END IF;

  IF NOT v_item.is_active OR v_item.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Inventory item has already been deleted';
  END IF;

  SELECT COALESCE(sum(on_hand), 0)
  INTO v_on_hand
  FROM public.v_item_location_stock
  WHERE item_id = _item_id;

  IF v_on_hand <> 0 THEN
    RAISE EXCEPTION 'Item cannot be deleted while stock remains. Current total is % %',
      v_on_hand, v_item.unit;
  END IF;

  PERFORM set_config('fruithub.inventory_item_lifecycle_rpc', 'allowed', true);

  UPDATE public.inventory_items
  SET is_active = false,
      status = 'deleted',
      deleted_at = now(),
      deleted_by = auth.uid(),
      deletion_reason = btrim(_reason)
  WHERE id = _item_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_inventory_item(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_inventory_item(uuid, text) TO authenticated;

-- Active Central Inventory excludes retired items, while historical reports
-- continue to resolve their item names through the underlying table.
CREATE OR REPLACE VIEW public.v_central_item_stock
WITH (security_invoker = true)
AS
WITH central AS (
  SELECT id
  FROM public.locations
  WHERE status = 'active'
    AND (is_default OR lower(name) = 'main store')
  ORDER BY is_default DESC, created_at
  LIMIT 1
), incoming AS (
  SELECT
    poi.item_id,
    poi.location_id,
    SUM(GREATEST(poi.quantity_ordered - poi.quantity_accepted, 0)) AS incoming_quantity
  FROM public.purchase_order_items poi
  JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
  WHERE po.workflow_status IN ('being_purchased','delivered','partially_received')
  GROUP BY poi.item_id, poi.location_id
)
SELECT
  ii.id AS item_id,
  ii.item_id AS item_code,
  ii.sku,
  ii.name,
  ii.category,
  ii.subcategory,
  ii.unit,
  ii.min_level,
  ii.reorder_level,
  ii.status,
  central.id AS location_id,
  COALESCE(stock.on_hand, 0) AS on_hand,
  COALESCE(incoming.incoming_quantity, 0) AS incoming_quantity,
  COALESCE(stock.on_hand, 0) + COALESCE(incoming.incoming_quantity, 0) AS projected_quantity
FROM public.inventory_items ii
CROSS JOIN central
LEFT JOIN public.v_item_location_stock stock
  ON stock.item_id = ii.id
 AND stock.location_id = central.id
LEFT JOIN incoming
  ON incoming.item_id = ii.id
 AND incoming.location_id = central.id
WHERE ii.is_active = true
  AND ii.status = 'active';

GRANT SELECT ON public.v_central_item_stock TO authenticated;

NOTIFY pgrst, 'reload schema';
