-- Business evidence is shared by authorised workflow roles, not all accounts.
-- has_any_role also checks profiles.is_active. Both buckets remain private.
BEGIN;

ALTER POLICY dispatch_invoices_read ON storage.objects
  USING (
    bucket_id = 'dispatch-invoices'
    AND public.has_any_role(auth.uid(), ARRAY[
      'super_admin','management','operations_manager','inventory_officer','sales'
    ]::public.app_role[])
  );

ALTER POLICY purchase_evidence_read ON storage.objects
  USING (
    bucket_id = 'purchase-evidence'
    AND public.has_any_role(auth.uid(), ARRAY[
      'super_admin','management','operations_manager','procurement','inventory_officer'
    ]::public.app_role[])
  );

ALTER POLICY dispatch_invoices_write ON storage.objects
  WITH CHECK (
    bucket_id = 'dispatch-invoices'
    AND owner_id = auth.uid()::text
    AND public.has_any_role(auth.uid(), ARRAY[
      'super_admin','management','operations_manager','inventory_officer','sales'
    ]::public.app_role[])
  );

ALTER POLICY purchase_evidence_insert ON storage.objects
  WITH CHECK (
    bucket_id = 'purchase-evidence'
    AND owner_id = auth.uid()::text
    AND public.has_any_role(auth.uid(), ARRAY[
      'super_admin','management','operations_manager','procurement','inventory_officer'
    ]::public.app_role[])
  );

-- Uploads use unique paths and upsert:false. Submitted evidence is immutable;
-- neither bucket grants UPDATE or DELETE to application users.
DROP POLICY IF EXISTS dispatch_invoices_update ON storage.objects;

NOTIFY pgrst, 'reload schema';
COMMIT;
