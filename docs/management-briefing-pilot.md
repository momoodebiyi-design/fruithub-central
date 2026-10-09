# Management briefing pilot

This pilot is intentionally limited to one active Super Admin who explicitly enables it on the **Management briefing** page. The number is read from that user's active profile at send time; it is not copied into code or the database configuration. Disabling the pilot immediately prevents new sends and inbound replies.

## Deployment order

1. Apply migration `20261009120000_management_briefing_pilot.sql` before publishing the app code.
2. Configure server-side `WHATSAPP_CLOUD_PHONE_NUMBER_ID`, `WHATSAPP_CLOUD_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, and `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. Reuse the existing WhatsApp webhook subscription, but ensure it subscribes to incoming `messages` as well as status changes.
3. Submit and obtain approval for a WhatsApp utility template. Set `WHATSAPP_BRIEFING_TEMPLATE_NAME` to its exact name and `WHATSAPP_TEMPLATE_LANGUAGE` to the approved language (default `en`). The template body must have three text placeholders, in order: report date, summary, and secure app link. Suggested wording: `4ruit management briefing for {{1}}: {{2}} Review details in the app: {{3}}`.
4. Set a long random `BRIEFING_CRON_SECRET` in the app's server environment. Configure a reliable external scheduler to send `POST https://fruithub-central.lovable.app/api/management-briefing-scheduled` daily at **07:00 UTC**, with the secret in the `x-briefing-cron-secret` header. Do not put the secret in source code. The connected GitHub token currently lacks `workflow` scope, so the proposed GitHub Actions workflow is held locally until that permission is granted or another scheduler is configured.
5. For the in-app read-only assistant, configure server-only `OPENAI_API_KEY` and `OPENAI_MODEL`. The assistant will show a setup message until both are present. Each question sends the database-derived briefing and the user's question to the configured OpenAI API; the UI discloses this. The assistant cannot run writes.
6. Sign in as the intended Super Admin, verify their profile phone, open **Management briefing**, and select **I consent — enable pilot**. There can be only one active enrollee. Do not enable for a shared account.
7. Test a manual send, delivery status, an inbound `briefing` message from the enrolled number, a duplicate inbound webhook, an unauthorised number, and `STOP` from the enrolled number. Verify that no other recipient is messaged and `STOP` disables future sends.

The scheduler must target 07:00 UTC = 08:00 Lagos. The endpoint accepts late runs until 11:59 Lagos time, sends at most once for one report date, and marks late deliveries with their actual timestamp. A failed send is retained for investigation; it is not blindly retried because a provider timeout could have delivered the first attempt. No automatic briefing is active until a scheduler is configured.

## Briefing definition

- Production batches, dispatches, returns, and submitted Central stocktakes are counted for the previous Lagos calendar day by their relevant recorded event timestamps.
- Pending purchase approvals and configured Central low-stock alerts are current **as-of** snapshots, not previous-day totals.
- Missing source data is labelled `unavailable`, not `0`. No submitted stocktake and any uncounted stocktake lines are flagged so management can check whether counting was missed.
- The WhatsApp summary links to the authenticated briefing page. It does not expose detailed records or allow stock changes or approvals.
- The assistant is limited to answering questions about the displayed briefing. Detailed item-level or historical questions should direct the user to reports.

## Acceptance checks

- Only an active Super Admin with a valid saved phone can opt in; one-person limit is enforced by the database.
- The scheduled job sends only to the opted-in profile, once per date, during the 08:00 Lagos hour.
- Only `briefing` from the opted-in phone receives an on-demand reply; duplicate Meta message IDs receive no second reply.
- Unknown or inactive users receive nothing. Disabling the pilot stops both scheduled and requested messages.
- Delivery status and consent changes are auditable. API secrets never reach the browser.
