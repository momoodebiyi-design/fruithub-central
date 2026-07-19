
-- Make user FK columns SET NULL on delete so admins can hard-delete users
-- whose only footprint is authorship metadata (not stock movements).
ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_created_by_fkey,
  ADD CONSTRAINT purchase_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.recipes DROP CONSTRAINT IF EXISTS recipes_created_by_fkey,
  ADD CONSTRAINT recipes_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.recipes DROP CONSTRAINT IF EXISTS recipes_approved_by_fkey,
  ADD CONSTRAINT recipes_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.sales_orders DROP CONSTRAINT IF EXISTS sales_orders_created_by_fkey,
  ADD CONSTRAINT sales_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.sales_orders DROP CONSTRAINT IF EXISTS sales_orders_fulfilled_by_fkey,
  ADD CONSTRAINT sales_orders_fulfilled_by_fkey FOREIGN KEY (fulfilled_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.sales_orders DROP CONSTRAINT IF EXISTS sales_orders_voided_by_fkey,
  ADD CONSTRAINT sales_orders_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Track invited/unconfirmed status through the invite trigger without
-- prematurely marking accepted. handle_new_user still resolves the invite
-- and creates the profile/role, but marks accepted only when email is
-- confirmed (below), so admins can still resend the invite email in the
-- meantime.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_invite public.user_invites%ROWTYPE;
  v_role_count integer;
  v_invite_token text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fruithub:user-bootstrap', 0));
  SELECT COUNT(*) INTO v_role_count FROM public.user_roles;

  IF v_role_count = 0 THEN
    INSERT INTO public.profiles (id, email, full_name)
    VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'super_admin') ON CONFLICT DO NOTHING;
    RETURN NEW;
  END IF;

  v_invite_token := NULLIF(btrim(NEW.raw_user_meta_data->>'invite_token'), '');
  IF v_invite_token IS NULL THEN
    RAISE EXCEPTION 'Sign-up requires a valid invitation. Contact an administrator.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invite FROM public.user_invites
  WHERE token = v_invite_token AND lower(email) = lower(NEW.email)
    AND accepted_at IS NULL AND cancelled_at IS NULL AND expires_at > now()
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sign-up requires a valid invitation. Contact an administrator.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, department)
  VALUES (NEW.id, NEW.email,
    COALESCE(v_invite.full_name, NEW.raw_user_meta_data->>'full_name', NEW.email),
    v_invite.department);
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, v_invite.role) ON CONFLICT DO NOTHING;

  -- Mark accepted only if the auth user is already confirmed (rare in normal
  -- invite flow). Otherwise leave pending so admins can resend.
  IF NEW.email_confirmed_at IS NOT NULL THEN
    UPDATE public.user_invites SET accepted_at = now() WHERE id = v_invite.id;
  END IF;
  RETURN NEW;
END;
$function$;

-- Mark invite accepted when the user finally confirms their email.
CREATE OR REPLACE FUNCTION public.mark_invite_accepted_on_confirm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.email_confirmed_at IS NOT NULL AND (OLD.email_confirmed_at IS NULL OR OLD.email_confirmed_at IS DISTINCT FROM NEW.email_confirmed_at) THEN
    UPDATE public.user_invites SET accepted_at = COALESCE(accepted_at, now())
    WHERE lower(email) = lower(NEW.email) AND accepted_at IS NULL AND cancelled_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS on_auth_user_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.mark_invite_accepted_on_confirm();

-- Backfill: any invites that were auto-accepted for still-unconfirmed
-- auth users should re-open so admins can resend.
UPDATE public.user_invites ui
SET accepted_at = NULL
FROM auth.users u
WHERE lower(ui.email) = lower(u.email)
  AND ui.accepted_at IS NOT NULL
  AND ui.cancelled_at IS NULL
  AND u.email_confirmed_at IS NULL;
