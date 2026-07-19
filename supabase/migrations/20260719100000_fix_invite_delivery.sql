-- Make invitation delivery observable and allow anonymous invite validation
-- without exposing the underlying invitation table.

ALTER TABLE public.user_invites
  ADD COLUMN IF NOT EXISTS email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS send_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_send_error text;

ALTER TABLE public.user_invites
  DROP CONSTRAINT IF EXISTS user_invites_send_count_nonnegative;

ALTER TABLE public.user_invites
  ADD CONSTRAINT user_invites_send_count_nonnegative CHECK (send_count >= 0);

CREATE OR REPLACE FUNCTION public.validate_user_invite(_token text)
RETURNS TABLE (
  email text,
  full_name text,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.email, i.full_name, i.expires_at
  FROM public.user_invites i
  WHERE i.token = NULLIF(btrim(_token), '')
    AND i.accepted_at IS NULL
    AND i.cancelled_at IS NULL
    AND i.expires_at > now()
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.validate_user_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_user_invite(text) TO anon, authenticated;

COMMENT ON FUNCTION public.validate_user_invite(text) IS
  'Returns only the recipient-facing fields for a single valid invitation token.';

