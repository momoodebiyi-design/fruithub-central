CREATE POLICY po_insert ON public.purchase_orders FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'management')
  OR public.has_role(auth.uid(), 'operations_manager')
  OR public.has_role(auth.uid(), 'procurement')
);

CREATE POLICY po_update ON public.purchase_orders FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'management')
  OR public.has_role(auth.uid(), 'operations_manager')
  OR public.has_role(auth.uid(), 'procurement')
)
WITH CHECK (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'management')
  OR public.has_role(auth.uid(), 'operations_manager')
  OR public.has_role(auth.uid(), 'procurement')
);

CREATE POLICY po_delete ON public.purchase_orders FOR DELETE TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'management')
);