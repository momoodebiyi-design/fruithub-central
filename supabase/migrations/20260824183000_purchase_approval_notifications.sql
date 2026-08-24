-- Make purchase approval alerts durable and auditable. Purchase submission
-- creates the in-app task and WhatsApp outbox records in the same transaction;
-- a server route delivers the external message without blocking the workflow.

CREATE TABLE IF NOT EXISTS public.purchase_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('whatsapp')),
  destination text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_order_id, recipient_user_id, channel)
);

CREATE INDEX IF NOT EXISTS purchase_notification_delivery_queue_idx
  ON public.purchase_notification_deliveries(status, created_at)
  WHERE status IN ('pending', 'failed', 'skipped');

CREATE UNIQUE INDEX IF NOT EXISTS purchase_notification_provider_message_idx
  ON public.purchase_notification_deliveries(provider_message_id)
  WHERE provider_message_id IS NOT NULL;

GRANT SELECT ON public.purchase_notification_deliveries TO authenticated;
GRANT ALL ON public.purchase_notification_deliveries TO service_role;
ALTER TABLE public.purchase_notification_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS purchase_notification_deliveries_read ON public.purchase_notification_deliveries;
CREATE POLICY purchase_notification_deliveries_read
  ON public.purchase_notification_deliveries
  FOR SELECT TO authenticated
  USING (
    recipient_user_id = auth.uid()
    OR public.has_any_role(
      auth.uid(),
      ARRAY[
        'super_admin',
        'management',
        'operations_manager',
        'procurement'
      ]::public.app_role[]
    )
  );

CREATE OR REPLACE FUNCTION public.submit_quoted_purchase_order(_purchase_order_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po public.purchase_orders%ROWTYPE;
  v_count integer;
  v_supplier_name text;
  v_requirements text;
  v_recipient record;
  v_recipient_count integer := 0;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin','management','operations_manager','procurement']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorised to submit purchase orders';
  END IF;

  SELECT * INTO v_po
  FROM public.purchase_orders
  WHERE id = _purchase_order_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;

  SELECT count(*) INTO v_count
  FROM public.purchase_order_items
  WHERE purchase_order_id = _purchase_order_id;

  IF v_po.workflow_status <> 'draft' THEN
    RAISE EXCEPTION 'Order is not a quoted draft';
  END IF;
  IF v_po.supplier_id IS NULL
     OR v_count = 0
     OR v_po.quoted_total <= 0
     OR COALESCE(btrim(v_po.quotation_reference), '') = '' THEN
    RAISE EXCEPTION 'Supplier, quote, quantities and costs are required';
  END IF;

  SELECT name INTO v_supplier_name
  FROM public.suppliers
  WHERE id = v_po.supplier_id;

  SELECT string_agg(
    concat(
      trim(trailing '.' FROM trim(trailing '0' FROM poi.quantity_ordered::text)),
      ' ', COALESCE(i.unit, 'unit'), ' ', i.name
    ),
    '; ' ORDER BY i.name
  )
  INTO v_requirements
  FROM public.purchase_order_items poi
  JOIN public.inventory_items i ON i.id = poi.item_id
  WHERE poi.purchase_order_id = _purchase_order_id;

  UPDATE public.purchase_orders
  SET workflow_status = 'awaiting_approval',
      submitted_by = auth.uid(),
      submitted_at = now(),
      updated_at = now()
  WHERE id = _purchase_order_id;

  FOR v_recipient IN
    SELECT DISTINCT p.id, p.phone
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.id
    WHERE p.is_active = true
      AND ur.role IN ('super_admin'::public.app_role, 'management'::public.app_role)
  LOOP
    v_recipient_count := v_recipient_count + 1;

    INSERT INTO public.notifications(
      user_id, title, body, level, link, notification_key
    )
    VALUES (
      v_recipient.id,
      'Purchase approval required: ' || v_po.po_number,
      left(
        concat(
          COALESCE(v_supplier_name, 'Supplier'), ' · ₦',
          to_char(v_po.quoted_total, 'FM999,999,999,990.00'),
          ' · ', COALESCE(v_requirements, 'Open the order to review its requirements.')
        ),
        1200
      ),
      'warn'::public.notification_level,
      '/purchasing?order=' || _purchase_order_id::text,
      'purchase-approval:' || _purchase_order_id::text || ':' || v_recipient.id::text
    )
    ON CONFLICT (notification_key)
      WHERE notification_key IS NOT NULL AND resolved_at IS NULL
      DO NOTHING;

    INSERT INTO public.purchase_notification_deliveries(
      purchase_order_id,
      recipient_user_id,
      channel,
      destination,
      status,
      last_error
    )
    VALUES (
      _purchase_order_id,
      v_recipient.id,
      'whatsapp',
      NULLIF(btrim(v_recipient.phone), ''),
      CASE WHEN COALESCE(btrim(v_recipient.phone), '') = '' THEN 'skipped' ELSE 'pending' END,
      CASE
        WHEN COALESCE(btrim(v_recipient.phone), '') = ''
        THEN 'WhatsApp number is not configured in the recipient profile'
        ELSE NULL
      END
    )
    ON CONFLICT (purchase_order_id, recipient_user_id, channel)
    DO UPDATE SET
      destination = EXCLUDED.destination,
      status = CASE
        WHEN public.purchase_notification_deliveries.status = 'sent' THEN 'sent'
        ELSE EXCLUDED.status
      END,
      last_error = CASE
        WHEN public.purchase_notification_deliveries.status = 'sent' THEN NULL
        ELSE EXCLUDED.last_error
      END,
      updated_at = now();
  END LOOP;

  INSERT INTO public.audit_log(user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(),
    'purchase_order.submitted',
    'purchase_orders',
    _purchase_order_id::text,
    jsonb_build_object(
      'total', v_po.quoted_total,
      'supplier', v_supplier_name,
      'requirements', v_requirements,
      'management_recipients', v_recipient_count,
      'approval_link', '/purchasing?order=' || _purchase_order_id::text
    )
  );

  RETURN _purchase_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_quoted_purchase_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_quoted_purchase_order(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.decide_purchase_order(
  _purchase_order_id uuid,
  _approve boolean,
  _reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po public.purchase_orders%ROWTYPE;
  v_threshold numeric;
BEGIN
  SELECT * INTO v_po
  FROM public.purchase_orders
  WHERE id = _purchase_order_id
  FOR UPDATE;

  IF NOT FOUND OR v_po.workflow_status <> 'awaiting_approval' THEN
    RAISE EXCEPTION 'Order is not awaiting approval';
  END IF;
  IF public.has_role(auth.uid(), 'procurement') THEN
    RAISE EXCEPTION 'Procurement cannot approve a purchase order';
  END IF;
  IF v_po.submitted_by = auth.uid() THEN
    RAISE EXCEPTION 'You submitted this order. Another authorised approver must decide it';
  END IF;

  SELECT routine_approval_threshold_naira INTO v_threshold
  FROM public.purchasing_settings
  WHERE id = true;

  IF v_threshold IS NULL THEN
    IF NOT public.has_any_role(
      auth.uid(), ARRAY['super_admin','management']::public.app_role[]
    ) THEN
      RAISE EXCEPTION 'MD approval is required until the monetary threshold is configured';
    END IF;
  ELSIF v_po.quoted_total <= v_threshold THEN
    IF NOT public.has_any_role(
      auth.uid(), ARRAY['super_admin','management','production']::public.app_role[]
    ) THEN
      RAISE EXCEPTION 'Production Manager or MD approval is required';
    END IF;
  ELSIF NOT public.has_any_role(
    auth.uid(), ARRAY['super_admin','management']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'MD approval is required for this order';
  END IF;

  IF NOT _approve AND COALESCE(btrim(_reason), '') = '' THEN
    RAISE EXCEPTION 'Rejection reason is required';
  END IF;

  UPDATE public.purchase_orders
  SET workflow_status = CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,
      approved_by = auth.uid(),
      approved_at = now(),
      rejection_reason = CASE WHEN _approve THEN NULL ELSE btrim(_reason) END,
      updated_at = now()
  WHERE id = _purchase_order_id;

  UPDATE public.purchase_needs
  SET status = CASE WHEN _approve THEN 'ordered' ELSE 'ready' END,
      updated_at = now()
  WHERE id IN (
    SELECT purchase_need_id
    FROM public.purchase_order_items
    WHERE purchase_order_id = _purchase_order_id
      AND purchase_need_id IS NOT NULL
  );

  UPDATE public.notifications
  SET resolved_at = now(),
      read_at = COALESCE(read_at, now())
  WHERE notification_key LIKE
    'purchase-approval:' || _purchase_order_id::text || ':%'
    AND resolved_at IS NULL;

  IF v_po.submitted_by IS NOT NULL THEN
    INSERT INTO public.notifications(
      user_id, title, body, level, link, notification_key
    )
    VALUES (
      v_po.submitted_by,
      CASE
        WHEN _approve THEN 'Purchase approved: ' || v_po.po_number
        ELSE 'Purchase rejected: ' || v_po.po_number
      END,
      CASE
        WHEN _approve THEN 'Procurement may now place the approved order.'
        ELSE 'Reason: ' || btrim(_reason)
      END,
      CASE WHEN _approve THEN 'info' ELSE 'warn' END::public.notification_level,
      '/purchasing?order=' || _purchase_order_id::text,
      'purchase-decision:' || _purchase_order_id::text || ':' || v_po.submitted_by::text
    )
    ON CONFLICT (notification_key)
      WHERE notification_key IS NOT NULL AND resolved_at IS NULL
      DO NOTHING;
  END IF;

  INSERT INTO public.audit_log(user_id, action, entity, entity_id, new_value)
  VALUES (
    auth.uid(),
    CASE WHEN _approve THEN 'purchase_order.approved' ELSE 'purchase_order.rejected' END,
    'purchase_orders',
    _purchase_order_id::text,
    jsonb_build_object('reason', _reason, 'submitted_by', v_po.submitted_by)
  );

  RETURN _purchase_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.decide_purchase_order(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_purchase_order(uuid, boolean, text) TO authenticated;
