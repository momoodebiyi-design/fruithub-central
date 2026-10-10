# Daily low-stock management briefing

The management briefing is a current low-stock snapshot of active inventory, not a general operations recap. It covers every active catalogue item in Central and every active item/location pair already represented by a stock balance or an approved stock-level policy at other active locations. An item without a location-specific policy is shown in the **threshold setup required** count; no reorder level is invented. Shop balances may be stale until POS stock depletion is live, so shop alerts must be checked against physical counts.

Active users with the `super_admin`, `management` or `operations_manager` role can view the briefing. Each person must save a unique WhatsApp number and explicitly opt in on the **Management briefing** page before receiving the daily message. `STOP` from that saved number disables future sends. Do not enroll shared accounts or add phone numbers on someone's behalf without consent.

## Deployment order

1. Apply `20261010190000_management_low_stock_subscribers.sql`. It removes the former one-recipient restriction without automatically enrolling anyone. Keep the prior `20261009120000_management_briefing_pilot.sql` migration in place.
2. Set server-only `WHATSAPP_CLOUD_PHONE_NUMBER_ID`, a durable `WHATSAPP_CLOUD_ACCESS_TOKEN` from the appropriate Meta system user, `WHATSAPP_APP_SECRET`, and `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. Limit the system user to the relevant app and WhatsApp business account. Never paste the token into source, chat or a public issue.
3. Obtain approval for the WhatsApp utility template. Set `WHATSAPP_BRIEFING_TEMPLATE_NAME` and `WHATSAPP_TEMPLATE_LANGUAGE` (default `en`). Its three body placeholders must be, in order: date, bounded low-stock summary, and authenticated app link. Daily sends cannot run until the template is approved. On-demand replies to an inbound `briefing` message are free-form within the conversation window.
4. Set a long random `BRIEFING_CRON_SECRET` on the app server. Schedule `POST https://fruithub-central.lovable.app/api/management-briefing-scheduled` for **07:00 UTC daily = 08:00 Africa/Lagos**, with that secret in the `x-briefing-cron-secret` header. A database scheduler using `pg_cron` and `pg_net`, with its secret in Supabase Vault, is suitable. Do not commit the secret to SQL or Git. The endpoint accepts delayed runs until 11:59 Lagos time and deduplicates by recipient/date.
5. Save individual management WhatsApp numbers and have each intended recipient opt in. The app displays active-user, valid-phone and opted-in counts. The schedule cannot reach all management users until those counts match.
6. Run an authorised manual send for one opted-in user. Verify Meta accepts the template, the provider status becomes delivered, an inbound `briefing` returns the current snapshot, duplicate webhook IDs do not send twice, `STOP` works, and a non-management/shared/unconsented number receives no briefing.
7. Inspect a physical low-stock sample at Central and each included shop. Configure approved thresholds for the remaining item/location pairs. The current briefing explicitly says how many are unconfigured; it must not be represented as comprehensive until coverage is sufficient.

The optional read-only assistant additionally requires server-only `OPENAI_API_KEY` and `OPENAI_MODEL`. It can explain the displayed low-stock snapshot but cannot change stock or approvals.

## Delivery safeguards

- The briefing uses live location-aware `v_item_location_stock` balances, not legacy global item quantities.
- Database-read failure aborts sending; it is never converted to zero stock.
- A configured pair with no balance row is treated as zero, because no stock movement has established a positive balance.
- Scheduled sends require the cron secret, an active opted-in management account, a unique valid saved number, and an approved template.
- Each scheduled delivery is recorded once per recipient and Lagos date. Provider failures are recorded for investigation; retries are not automatic because a timeout may conceal a successful send.
- The WhatsApp body is bounded and may show only a subset of low-stock lines; the authenticated app page contains the full list and coverage warning.
- No automatic daily briefing is live until the scheduler, durable Meta credentials, template approval and recipient opt-ins are confirmed.
