BEGIN;

-- Prevent direct database writes/reads from bypassing the invitation endpoint.
ALTER POLICY invites_admin_manage ON public.user_invites
USING (
  public.has_role(auth.uid(),'super_admin'::public.app_role)
  OR (role <> 'super_admin'::public.app_role AND public.has_role(auth.uid(),'admin'::public.app_role))
)
WITH CHECK (
  public.has_role(auth.uid(),'super_admin'::public.app_role)
  OR (role <> 'super_admin'::public.app_role AND public.has_role(auth.uid(),'admin'::public.app_role))
);

ALTER POLICY user_roles_write_admin ON public.user_roles
USING (
  public.has_role(auth.uid(),'super_admin'::public.app_role)
  OR (role <> 'super_admin'::public.app_role AND public.has_role(auth.uid(),'admin'::public.app_role))
)
WITH CHECK (
  public.has_role(auth.uid(),'super_admin'::public.app_role)
  OR (role <> 'super_admin'::public.app_role AND public.has_role(auth.uid(),'admin'::public.app_role))
);

-- SECURITY DEFINER lifecycle functions bypass RLS; guard those paths too.
CREATE OR REPLACE FUNCTION public.guard_super_admin_invitation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF auth.role()='authenticated' AND NOT public.has_role(auth.uid(),'super_admin'::public.app_role)
     AND (NEW.role='super_admin'::public.app_role
       OR (TG_OP='UPDATE' AND OLD.role='super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'Only a Super Admin may manage Super Admin invitations' USING ERRCODE='42501';
  END IF;
  IF NEW.role='super_admin'::public.app_role
     AND (TG_OP='INSERT' OR NEW.role IS DISTINCT FROM OLD.role OR NEW.invited_by IS DISTINCT FROM OLD.invited_by)
     AND NOT public.has_role(NEW.invited_by,'super_admin'::public.app_role) THEN
    RAISE EXCEPTION 'Super Admin invitations require a Super Admin sponsor' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_super_admin_invitation() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_super_admin_invitation ON public.user_invites;
CREATE TRIGGER guard_super_admin_invitation BEFORE INSERT OR UPDATE ON public.user_invites
FOR EACH ROW EXECUTE FUNCTION public.guard_super_admin_invitation();

-- Private files: uploader access or an actual linked workflow document.
-- Existing path names are preserved; no file relocation or deletion.
ALTER POLICY dispatch_invoices_read ON storage.objects
USING (
  bucket_id='dispatch-invoices'
  AND public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','inventory_officer','sales']::public.app_role[])
  AND (owner_id=auth.uid()::text OR EXISTS (
    SELECT 1 FROM public.dispatches d WHERE d.invoice_url=storage.objects.name
  ))
);
ALTER POLICY purchase_evidence_read ON storage.objects
USING (
  bucket_id='purchase-evidence'
  AND public.has_any_role(auth.uid(),ARRAY['super_admin','management','operations_manager','procurement','inventory_officer']::public.app_role[])
  AND (owner_id=auth.uid()::text OR EXISTS (
    SELECT 1 FROM public.purchase_orders o
    WHERE o.quotation_evidence_path=storage.objects.name OR o.payment_evidence_path=storage.objects.name
  ) OR EXISTS (
    SELECT 1 FROM public.purchase_receipts r WHERE r.delivery_evidence_path=storage.objects.name
  ))
);

NOTIFY pgrst,'reload schema';
COMMIT;
