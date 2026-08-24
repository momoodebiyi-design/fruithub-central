# WhatsApp Cloud API setup for purchase approvals

The application sends WhatsApp as an alert only. Approve and reject actions remain in the
authenticated purchasing screen so the existing role checks and audit trail cannot be bypassed.

## Meta template

Create and approve a **Utility** template in WhatsApp Manager with:

- Name: `purchase_approval_required`
- Language: English (`en`)
- Body:

```text
Purchase approval is required for {{1}}.
Supplier: {{2}}
Total: {{3}}
Requirements: {{4}}

Review and decide securely in the 4ruit operations app: {{5}}

Do not approve or reject by replying to this message.
```

The application supplies the order number, supplier, total, item summary and authenticated app
link in that order. If Meta approves a different name or language, configure the matching values
below.

## Server secrets

Add these as server-side deployment secrets. Never expose the access token as a client-side/Vite
variable.

- `WHATSAPP_CLOUD_PHONE_NUMBER_ID` — the WhatsApp Business sender phone-number ID.
- `WHATSAPP_CLOUD_ACCESS_TOKEN` — a production system-user token with WhatsApp messaging access.
- `WHATSAPP_GRAPH_API_VERSION` — optional; defaults to `v23.0`.
- `WHATSAPP_PURCHASE_TEMPLATE_NAME` — optional; defaults to
  `purchase_approval_required`.
- `WHATSAPP_TEMPLATE_LANGUAGE` — optional; defaults to `en`.
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` — a private value you choose and also enter when configuring
  Meta's webhook.
- `WHATSAPP_APP_SECRET` — the Meta app secret used to reject forged webhook status updates.
- `WHATSAPP_DEFAULT_COUNTRY_CODE` — optional; defaults to Nigeria (`234`) for locally entered
  numbers beginning with zero.
- `APP_URL` — the published application origin used to build the secure review link.

## Management recipients

Every active user holding the `super_admin` or `management` role receives an in-app approval task.
WhatsApp is sent only when that user's Profile contains a valid mobile number. International format
such as `+2348012345678` is recommended.

Delivery status is retained per order and recipient. Failed or skipped deliveries can be retried
from the order details after correcting the number or provider setup.

## Delivery-status webhook

Configure Meta's WhatsApp webhook callback as:

```text
https://YOUR-PUBLISHED-APP/api/whatsapp-webhook
```

Subscribe the WhatsApp Business Account to message-status events. The callback verifies Meta's
signature before recording `sent`, `delivered`, `read` or `failed` against the original order alert.
