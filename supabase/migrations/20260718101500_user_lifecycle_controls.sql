-- Reversible user lifecycle controls for the MVP.
-- Auth identities, profiles, roles and audit history are preserved.

ALTER TABLE public.user_invites
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

CREATE INDEX IF NOT EXISTS user_invites_pending_lookup_idx
  ON public.user_invites (lower(email), expires_at DESC)
  WHERE accepted_at IS NULL AND cancelled_at IS NULL;

-- An inactive profile must never satisfy a role-based RLS check.
CREATE OR REPLACE FUNCTION public.has_role(
  _user_id uuid,
  _role public.app_role
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.user_id = _user_id
      AND ur.role = _role
      AND p.is_active = true
  )
$$;

CREATE OR REPLACE FUNCTION public.has_any_role(
  _user_id uuid,
  _roles public.app_role[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.user_id = _user_id
      AND ur.role = ANY(_roles)
      AND p.is_active = true
  )
$$;

-- Protected lifecycle fields may only change through the audited RPCs below.
CREATE OR REPLACE FUNCTION public.guard_user_lifecycle_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'profiles'
     AND NEW.is_active IS DISTINCT FROM OLD.is_active
     AND current_setting('fruithub.user_lifecycle_rpc', true) IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'User status must be changed through the user-management workflow';
  END IF;

  IF TG_TABLE_NAME = 'user_invites'
     AND (
       NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
     )
     AND current_setting('fruithub.user_lifecycle_rpc', true) IS DISTINCT FROM 'allowed' THEN
    RAISE EXCEPTION 'Invitations must be cancelled through the user-management workflow';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profile_active_status ON public.profiles;
CREATE TRIGGER trg_guard_profile_active_status
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_user_lifecycle_fields();

DROP TRIGGER IF EXISTS trg_guard_invite_cancellation ON public.user_invites;
CREATE TRIGGER trg_guard_invite_cancellation
BEFORE UPDATE ON public.user_invites
FOR EACH ROW EXECUTE FUNCTION public.guard_user_lifecycle_fields();

CREATE OR REPLACE FUNCTION public.cancel_user_invite(
  _invite_id uuid,
  _reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite public.user_invites%ROWTYPE;
  v_reason text := btrim(COALESCE(_reason, ''));
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin', 'admin']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorized to cancel invitations';
  END IF;

  IF v_reason = '' THEN
    RAISE EXCEPTION 'A cancellation reason is required';
  END IF;

  SELECT *
  INTO v_invite
  FROM public.user_invites
  WHERE id = _invite_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found';
  END IF;

  IF v_invite.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Accepted invitations cannot be cancelled';
  END IF;

  IF v_invite.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation is already cancelled';
  END IF;

  PERFORM set_config('fruithub.user_lifecycle_rpc', 'allowed', true);

  UPDATE public.user_invites
  SET cancelled_at = now(),
      cancelled_by = auth.uid(),
      cancel_reason = v_reason
  WHERE id = _invite_id;

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
    'invite.cancelled',
    'user_invites',
    _invite_id::text,
    jsonb_build_object(
      'email', v_invite.email,
      'role', v_invite.role,
      'status', 'pending'
    ),
    jsonb_build_object(
      'email', v_invite.email,
      'role', v_invite.role,
      'status', 'cancelled',
      'reason', v_reason
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_user_active_status(
  _target_user_id uuid,
  _is_active boolean,
  _reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_reason text := btrim(COALESCE(_reason, ''));
  v_target_is_super_admin boolean;
  v_actor_is_super_admin boolean;
  v_active_super_admins integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_any_role(
    auth.uid(),
    ARRAY['super_admin', 'admin']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorized to manage users';
  END IF;

  IF _target_user_id IS NULL OR _is_active IS NULL THEN
    RAISE EXCEPTION 'Target user and status are required';
  END IF;

  IF v_reason = '' THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  SELECT *
  INTO v_profile
  FROM public.profiles
  WHERE id = _target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User profile not found';
  END IF;

  IF v_profile.is_active = _is_active THEN
    RAISE EXCEPTION 'User is already %', CASE WHEN _is_active THEN 'active' ELSE 'inactive' END;
  END IF;

  IF _target_user_id = auth.uid() AND _is_active = false THEN
    RAISE EXCEPTION 'You cannot deactivate your own account';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _target_user_id AND role = 'super_admin'
  ) INTO v_target_is_super_admin;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'super_admin'
  ) INTO v_actor_is_super_admin;

  IF v_target_is_super_admin AND NOT v_actor_is_super_admin THEN
    RAISE EXCEPTION 'Only a Super Admin can change another Super Admin';
  END IF;

  IF v_target_is_super_admin AND _is_active = false THEN
    SELECT COUNT(*)
    INTO v_active_super_admins
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.role = 'super_admin'
      AND p.is_active = true;

    IF v_active_super_admins <= 1 THEN
      RAISE EXCEPTION 'The last active Super Admin cannot be deactivated';
    END IF;
  END IF;

  PERFORM set_config('fruithub.user_lifecycle_rpc', 'allowed', true);

  UPDATE public.profiles
  SET is_active = _is_active
  WHERE id = _target_user_id;

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
    CASE WHEN _is_active THEN 'user.reactivated' ELSE 'user.deactivated' END,
    'profiles',
    _target_user_id::text,
    jsonb_build_object(
      'email', v_profile.email,
      'is_active', v_profile.is_active
    ),
    jsonb_build_object(
      'email', v_profile.email,
      'is_active', _is_active,
      'reason', v_reason
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_user_invite(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_user_invite(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.set_user_active_status(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_user_active_status(uuid, boolean, text) TO authenticated;

-- Keep invite enforcement authoritative at signup and reject cancelled links.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite public.user_invites%ROWTYPE;
  v_role_count integer;
  v_invite_token text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fruithub:user-bootstrap', 0));

  SELECT COUNT(*) INTO v_role_count FROM public.user_roles;

  IF v_role_count = 0 THEN
    INSERT INTO public.profiles (id, email, full_name)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email)
    );

    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'super_admin')
    ON CONFLICT DO NOTHING;

    RETURN NEW;
  END IF;

  v_invite_token := NULLIF(btrim(NEW.raw_user_meta_data->>'invite_token'), '');

  IF v_invite_token IS NULL THEN
    RAISE EXCEPTION 'Sign-up requires a valid invitation. Contact an administrator.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
  INTO v_invite
  FROM public.user_invites
  WHERE token = v_invite_token
    AND lower(email) = lower(NEW.email)
    AND accepted_at IS NULL
    AND cancelled_at IS NULL
    AND expires_at > now()
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sign-up requires a valid invitation. Contact an administrator.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, department)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(v_invite.full_name, NEW.raw_user_meta_data->>'full_name', NEW.email),
    v_invite.department
  );

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, v_invite.role)
  ON CONFLICT DO NOTHING;

  UPDATE public.user_invites
  SET accepted_at = now()
  WHERE id = v_invite.id;

  RETURN NEW;
END;
$$;
