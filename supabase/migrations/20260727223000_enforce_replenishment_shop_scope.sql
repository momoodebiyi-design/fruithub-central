-- PostgreSQL combines multiple permissive policies with OR. Remove the older
-- broad insert policy so the shop-scoped replenishment policy is authoritative.
DROP POLICY IF EXISTS "Signed in can create requests" ON public.stock_requests;

DROP POLICY IF EXISTS stock_requests_insert ON public.stock_requests;
CREATE POLICY stock_requests_insert
ON public.stock_requests
FOR INSERT
TO authenticated
WITH CHECK (
  requested_by = auth.uid()
  AND (
    NOT public.has_role(auth.uid(), 'shop_supervisor')
    OR destination_shop_id = (
      SELECT p.shop_id
      FROM public.profiles p
      WHERE p.id = auth.uid()
    )
  )
);
