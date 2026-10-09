-- One-person, opt-in WhatsApp briefing pilot. No phone number is copied into
-- configuration: delivery always reads the recipient's current profile.
CREATE TABLE IF NOT EXISTS public.management_briefing_pilot (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  consented_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT briefing_enabled_requires_consent CHECK (NOT enabled OR consented_at IS NOT NULL)
);

-- Until the pilot is reviewed, at most one person may receive messages.
CREATE UNIQUE INDEX IF NOT EXISTS management_briefing_one_enabled_pilot
  ON public.management_briefing_pilot ((true)) WHERE enabled;

CREATE TABLE IF NOT EXISTS public.management_briefing_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  report_date date NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('scheduled', 'whatsapp_request', 'in_app_request')),
  inbound_message_id text UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'delivered', 'read', 'failed')),
  provider_message_id text UNIQUE,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT briefing_inbound_id_required CHECK (
    trigger_type <> 'whatsapp_request' OR inbound_message_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS management_briefing_scheduled_once
  ON public.management_briefing_deliveries (recipient_user_id, report_date)
  WHERE trigger_type = 'scheduled';

CREATE INDEX IF NOT EXISTS management_briefing_deliveries_recipient_idx
  ON public.management_briefing_deliveries (recipient_user_id, created_at DESC);

ALTER TABLE public.management_briefing_pilot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.management_briefing_deliveries ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.management_briefing_pilot, public.management_briefing_deliveries TO authenticated;
GRANT ALL ON public.management_briefing_pilot, public.management_briefing_deliveries TO service_role;

CREATE POLICY management_briefing_pilot_read_own
  ON public.management_briefing_pilot FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY management_briefing_deliveries_read_own
  ON public.management_briefing_deliveries FOR SELECT TO authenticated
  USING (recipient_user_id = auth.uid());

NOTIFY pgrst, 'reload schema';
