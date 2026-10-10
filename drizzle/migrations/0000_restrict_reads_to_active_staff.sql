CREATE OR REPLACE FUNCTION public.is_active_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = _user_id AND p.is_active)
     AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = _user_id)
$$;
REVOKE ALL ON FUNCTION public.is_active_staff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_staff(uuid) TO authenticated, service_role;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename, policyname FROM pg_policies
           WHERE schemaname='public' AND cmd='SELECT' AND qual='true'
             AND roles = '{authenticated}'
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.%I USING (public.is_active_staff(auth.uid()))', r.policyname, r.tablename);
  END LOOP;
END $$;