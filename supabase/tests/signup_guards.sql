-- Regression checks for the signup / bootstrap guards.
-- These assertions protect the fix for:
--   * OPEN_SIGNUP_BROAD_READ / open_signup_readonly (2026-07-19)
--
-- Any future edit that removes the invite requirement, restores a default
-- readonly grant, or detaches the trigger from auth.users must fail here.
--
-- Runs read-only against the DB. No writes. Safe on production.
--
--   Usage:  psql -v ON_ERROR_STOP=1 -f supabase/tests/signup_guards.sql
--           (or via scripts/run-security-tests.sh)

\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'ASSERT FAILED: %', msg;
  END IF;
  RAISE NOTICE '  ok  %', msg;
END $$;

DO $$
DECLARE
  v_role_count int;
  v_bootstrap  boolean;
  v_src        text;
  v_trigger    record;
BEGIN
  RAISE NOTICE '== signup_guards regression suite ==';

  ----------------------------------------------------------------------------
  -- 1. bootstrap_allowed() must be false once any user_roles row exists.
  ----------------------------------------------------------------------------
  SELECT count(*) INTO v_role_count FROM public.user_roles;
  SELECT public.bootstrap_allowed() INTO v_bootstrap;

  IF v_role_count = 0 THEN
    PERFORM pg_temp.assert(v_bootstrap = true,
      'bootstrap_allowed() must be TRUE when user_roles is empty');
  ELSE
    PERFORM pg_temp.assert(v_bootstrap = false,
      'bootstrap_allowed() must be FALSE once user_roles has any row');
  END IF;

  ----------------------------------------------------------------------------
  -- 2. bootstrap_allowed() shape: SECURITY DEFINER, reads user_roles.
  ----------------------------------------------------------------------------
  SELECT pg_get_functiondef('public.bootstrap_allowed()'::regprocedure) INTO v_src;
  PERFORM pg_temp.assert(v_src ~* 'security\s+definer',
    'bootstrap_allowed() must be SECURITY DEFINER (RLS blocks anon count)');
  PERFORM pg_temp.assert(v_src ~* 'public\.user_roles',
    'bootstrap_allowed() must read public.user_roles');

  ----------------------------------------------------------------------------
  -- 3. handle_new_user must enforce invite validation.
  ----------------------------------------------------------------------------
  SELECT pg_get_functiondef('public.handle_new_user()'::regprocedure) INTO v_src;

  PERFORM pg_temp.assert(v_src ~* 'security\s+definer',
    'handle_new_user must remain SECURITY DEFINER');
  PERFORM pg_temp.assert(v_src ~* 'invite_token',
    'handle_new_user must read raw_user_meta_data->>''invite_token''');
  PERFORM pg_temp.assert(v_src ~* 'public\.user_invites',
    'handle_new_user must look up public.user_invites');
  PERFORM pg_temp.assert(v_src ~* 'accepted_at\s+IS\s+NULL',
    'invite lookup must require accepted_at IS NULL');
  PERFORM pg_temp.assert(v_src ~* 'cancelled_at\s+IS\s+NULL',
    'invite lookup must require cancelled_at IS NULL');
  PERFORM pg_temp.assert(v_src ~* 'expires_at\s*>\s*now\(\)',
    'invite lookup must require expires_at > now()');
  PERFORM pg_temp.assert(v_src ~* 'lower\(email\)\s*=\s*lower\(NEW\.email\)',
    'invite lookup must match on lower(email) = lower(NEW.email)');
  PERFORM pg_temp.assert(
    v_src ~* 'requires\s+a\s+valid\s+invitation',
    'handle_new_user must raise the "valid invitation" error when missing/invalid');
  PERFORM pg_temp.assert(v_src ~* 'P0001',
    'invite rejection must raise SQLSTATE P0001');

  ----------------------------------------------------------------------------
  -- 4. handle_new_user must NOT default new users to the readonly role.
  --    (Historical regression: the trigger used to grant readonly when no
  --    invite matched — see 2026-07-19 security fix.)
  ----------------------------------------------------------------------------
  PERFORM pg_temp.assert(
    v_src !~* $$values\s*\([^)]*'readonly'$$,
    'handle_new_user must not insert a default ''readonly'' user_roles row');
  PERFORM pg_temp.assert(
    v_src !~* $$coalesce\([^)]*'readonly'$$,
    'handle_new_user must not COALESCE role to ''readonly''');

  ----------------------------------------------------------------------------
  -- 5. Only the super-admin bootstrap branch may grant super_admin
  --    (guarded by v_role_count = 0 check).
  ----------------------------------------------------------------------------
  PERFORM pg_temp.assert(v_src ~* 'v_role_count\s*=\s*0',
    'handle_new_user must gate super_admin grant behind v_role_count = 0');

  ----------------------------------------------------------------------------
  -- 6. Trigger must still be attached to auth.users and enabled.
  ----------------------------------------------------------------------------
  SELECT tgname, tgrelid::regclass::text AS tbl, tgenabled
    INTO v_trigger
    FROM pg_trigger
   WHERE tgfoid = 'public.handle_new_user'::regproc
     AND NOT tgisinternal;

  PERFORM pg_temp.assert(v_trigger.tbl = 'auth.users',
    'handle_new_user must be a trigger on auth.users');
  PERFORM pg_temp.assert(v_trigger.tgenabled IN ('O','A','R'),
    'handle_new_user trigger must be enabled (tgenabled != D)');

  ----------------------------------------------------------------------------
  -- 7. validate_user_invite RPC (used by /auth) must remain SECURITY DEFINER
  --    and filter on the same invalidation columns.
  ----------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'validate_user_invite'
             AND pronamespace = 'public'::regnamespace) THEN
    SELECT pg_get_functiondef(oid) INTO v_src
      FROM pg_proc WHERE proname = 'validate_user_invite'
       AND pronamespace = 'public'::regnamespace LIMIT 1;
    PERFORM pg_temp.assert(v_src ~* 'security\s+definer',
      'validate_user_invite must be SECURITY DEFINER');
    PERFORM pg_temp.assert(v_src ~* 'expires_at\s*>\s*now\(\)',
      'validate_user_invite must reject expired invites');
    PERFORM pg_temp.assert(v_src ~* 'accepted_at\s+IS\s+NULL',
      'validate_user_invite must reject already-accepted invites');
    PERFORM pg_temp.assert(v_src ~* 'cancelled_at\s+IS\s+NULL',
      'validate_user_invite must reject cancelled invites');
  END IF;

  RAISE NOTICE '== all signup guard checks passed ==';
END $$;

SELECT 'signup_guards: PASS' AS result;
