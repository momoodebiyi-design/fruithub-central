-- Temporary role and invitation changes are rolled back; no emails sent.
BEGIN;
DO $$
DECLARE
  actor uuid;
  super_actor uuid;
  ordinary_invite uuid;
  super_invite uuid;
  changed integer;
BEGIN
  SELECT user_id INTO actor FROM public.user_roles WHERE role='management' LIMIT 1;
  SELECT user_id INTO super_actor FROM public.user_roles WHERE role='super_admin' LIMIT 1;
  IF actor IS NULL OR super_actor IS NULL THEN RAISE EXCEPTION 'Test identities missing'; END IF;
  INSERT INTO public.user_roles(user_id,role) VALUES(actor,'admin') ON CONFLICT DO NOTHING;
  INSERT INTO public.user_invites(email,role,invited_by) VALUES
    ('security-test-normal@example.invalid','production',actor) RETURNING id INTO ordinary_invite;
  INSERT INTO public.user_invites(email,role,invited_by) VALUES
    ('security-test-super@example.invalid','super_admin',super_actor) RETURNING id INTO super_invite;

  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.user_invites(email,role,invited_by) VALUES
      ('security-test-denied@example.invalid','super_admin',actor);
    RAISE EXCEPTION 'Admin created Super Admin invite';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.user_invites SET role='super_admin' WHERE id=ordinary_invite;
    RAISE EXCEPTION 'Admin elevated an invitation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.user_roles(user_id,role) VALUES(actor,'super_admin');
    RAISE EXCEPTION 'Admin promoted themselves';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT count(*) INTO changed FROM public.user_invites WHERE id=super_invite;
  IF changed<>0 THEN RAISE EXCEPTION 'Admin read Super Admin invitation token'; END IF;
  BEGIN
    PERFORM public.cancel_user_invite(super_invite,'security-test');
    RAISE EXCEPTION 'Admin cancelled Super Admin invite through RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  INSERT INTO public.user_invites(email,role,invited_by) VALUES
    ('security-test-allowed@example.invalid','production',actor);
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub',super_actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',super_actor,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.user_invites(email,role,invited_by) VALUES
    ('security-test-super-allowed@example.invalid','super_admin',super_actor);
  EXECUTE 'RESET ROLE';
END $$;
ROLLBACK;
SELECT 'PASS: Admin cannot invite/promote/cancel/read Super Admin invitations; normal invites and Super Admin authorisation preserved; tests rolled back' AS result;
