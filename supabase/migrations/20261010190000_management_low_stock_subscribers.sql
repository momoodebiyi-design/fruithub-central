-- The original WhatsApp briefing was restricted to one consenting Super Admin.
-- Keep each person's consent record, but allow multiple active management users
-- to opt in. The application still verifies role, active profile and phone at
-- every send; no existing user is silently enrolled by this migration.
DROP INDEX IF EXISTS public.management_briefing_one_enabled_pilot;

COMMENT ON TABLE public.management_briefing_pilot IS
  'Per-user opt-in for 4ruit low-stock WhatsApp briefings (legacy table name retained).';

NOTIFY pgrst, 'reload schema';
