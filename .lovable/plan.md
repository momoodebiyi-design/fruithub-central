# Fruit Naturel Ops Platform — v1

Build an internal operations app with the "Bottling line precision" look: light zinc surface, brand-orange accent, mono numerics, sidebar + topbar shell.

## Scope in v1

1. **Foundation** — Lovable Cloud, auth (invite-only), roles/permissions, app shell, dashboard, notifications, audit log.
2. **Inventory** — items, movements, low-stock alerts, categories, batches/expiry.
3. **Production** — batches auto-consume raw materials & packaging, auto-increment finished goods.

Procurement, Events, and Reports/Export are scaffolded (nav entries + placeholder pages) but full functionality lands in a follow-up.

## Design system

Apply the chosen prototype's tokens verbatim into `src/styles.css`:

- Fonts: Inter (sans), JetBrains Mono (mono, for numerics).
- Accents: brand orange `#f06324`, wineish red `#80153d`, green `#1d552d`, lime `#ccdd47`.
- Surface: zinc-50 background, white panels with `ring-1 ring-black/5`.
- Composition: 256px sidebar, 64px topbar with global search + notifications bell + primary action, main canvas max-w-7xl.
- Status pills: color-coded badges (Healthy / Low / Critical / Warning).

## App shell & routing

TanStack Start routes:

```text
/                                 → redirect to /dashboard if authed, else /auth
/auth                             → sign-in (public)
/reset-password                   → public
/_authenticated/dashboard
/_authenticated/inventory         → list + filters
/_authenticated/inventory/$id     → detail + movement history
/_authenticated/production        → batches list
/_authenticated/production/new    → record batch (consumes stock)
/_authenticated/procurement       → placeholder
/_authenticated/events            → placeholder
/_authenticated/reports           → placeholder
/_authenticated/notifications     → all notifications
/_authenticated/audit             → audit log (admin/mgmt only)
/_authenticated/users             → user + role management (admin only)
/_authenticated/settings/profile  → own profile, password
```

Sidebar items hide based on permissions. Protected subtree uses the integration-managed `_authenticated/route.tsx`.

## Backend (Lovable Cloud)

### Enums

- `app_role`: `super_admin`, `management`, `operations_manager`, `production`, `inventory_officer`, `procurement`, `admin`, `event_team`, `sales`, `readonly`.
- `inventory_category`: `packaging`, `raw_material`, `consumable`, `finished_good`.
- `movement_type`: `stock_in`, `stock_out`, `transfer`, `adjustment`, `damaged`, `expired`, `wastage`, `production_consume`, `production_output`.
- `batch_status`: `planned`, `in_progress`, `completed`, `qc_passed`, `qc_failed`.

### Tables (all in `public`, RLS on, GRANTs for authenticated + service_role)

- `profiles` — id (fk auth.users), full_name, department, phone, avatar_url, is_active, created_at.
- `user_roles` — user_id, role (`app_role`), unique(user_id, role).
- `user_invites` — email, role, invited_by, token, expires_at, accepted_at.
- `suppliers` — id, name, contact, email, phone, notes.
- `inventory_items` — id, sku (unique), name, category, unit, supplier_id, purchase_cost, quantity, min_level, reorder_level, location, notes, is_active, created_at, updated_at.
- `inventory_batches` — id, item_id, batch_number, expiry_date, quantity, received_at.
- `inventory_movements` — id, item_id, batch_id, type (`movement_type`), quantity (signed), reason, related_batch_id (production), performed_by, created_at.
- `production_batches` — id, batch_number, product_item_id (finished_good), quantity_produced, produced_at, status, qc_notes, staff_id, created_at.
- `production_consumption` — id, production_batch_id, item_id, quantity_used. (Snapshot of what was consumed.)
- `notifications` — id, user_id (nullable = broadcast), title, body, level (info/warn/critical), link, read_at, created_at.
- `announcements` — id, title, body, created_by, created_at.
- `audit_log` — id, user_id, action, entity, entity_id, previous_value (jsonb), new_value (jsonb), created_at.

### Security helpers

- `public.has_role(_user_id uuid, _role app_role)` — SECURITY DEFINER, used by RLS to avoid recursion.
- Trigger `handle_new_user` on `auth.users` insert → creates `profiles`. If the email matches an unaccepted `user_invites` row: create matching `user_roles` and mark accepted. If no invite: leave role empty (super admin must assign) — matches invite-only mode.
- Trigger on `inventory_movements` insert → adjusts `inventory_items.quantity`; if quantity crosses `min_level` or `reorder_level`, insert a `notifications` row for users with `inventory_officer`/`operations_manager`/`management` roles.
- Trigger on `production_batches` completion → generates consumption movements and one output movement.

### RLS shape

- `profiles`: user reads own; admins/management read all.
- `user_roles`: user reads own; only super_admin/admin write via server fn.
- `inventory_items` / `movements` / `batches`: authenticated read; write requires `inventory_officer`/`operations_manager`/`super_admin` (via `has_role`).
- `production_batches`: authenticated read; write requires `production`/`operations_manager`/`super_admin`.
- `audit_log`: read requires `management`/`super_admin`.
- `notifications`: user reads own + broadcasts; write via server fn/trigger only.

### First admin bootstrap

Since no email was provided, use the **first-signup-becomes-super-admin** fallback: `handle_new_user` checks if any `user_roles` row exists; if not, the new user gets `super_admin`. After that, public signup is disabled and the super admin creates invites for everyone else. The user can share their desired admin email during first signup.

## Server functions (createServerFn)

- `inviteUser({email, role})` — admin only, generates invite token, sends email via Resend (in-app + email).
- `assignRole({userId, role})` / `revokeRole` — super_admin only.
- `recordMovement({item_id, type, quantity, reason, batch_id?})` — writes movement + audit log.
- `recordProduction({product_item_id, quantity, batch_number, consumption: [{item_id, quantity}]})` — validates stock, creates production_batch + consumption rows + movements atomically (via SQL function).
- `markNotificationRead({id})`, `markAllRead()`.
- `listAuditLog({filters})` — role-gated.

## Notifications

- In-app: bell in topbar with unread badge, dropdown showing latest 10, `/notifications` page for all. Realtime via Supabase channel on `notifications` filtered by `user_id`.
- Email via Resend: connect Resend connector, wire a server fn `sendEmail` that gateways through `https://connector-gateway.lovable.dev/resend/emails`. Used for: invites, low-stock critical alerts, weekly digest (later).
- Triggers set: stock below min, reorder reached, expiry within 14 days (nightly server-side check deferred; low-stock is immediate via DB trigger).

## Inventory UI

- List page: search, category filter, status filter, sortable columns. Each row: SKU/name, category, quantity (mono), min level, status pill, location.
- Row click → detail page with movement history timeline, batch list with expiry countdown, edit form (permission-gated).
- Actions (dialog): Add stock, Remove stock, Transfer, Adjust, Record damaged/expired/wastage. Each action writes a movement + audit entry.
- Empty seed data with realistic juice items across all three categories.

## Production UI

- Batches list: batch #, product, quantity, status pill, date, staff.
- "Record batch" page: pick finished-good item, quantity, batch number (auto-suggest), add consumption rows (raw materials + packaging with live stock check), QC status, notes. Submits to `recordProduction` server fn; on success, stock reflects immediately.
- Guardrail: if any consumption row exceeds available stock, block submit with clear inline error.

## Dashboard

Match the prototype composition exactly:

- Header row with "Live" and "Operational" pills.
- 5 KPI cards: Inventory Value, Low Stock SKUs, Daily Yield (today's production L), Procurement pending (from placeholder table `procurement_requests` — 0 for now), Events today (0 for now).
- Charts row: Inventory trend line (last 30 days aggregated from movements) + Production efficiency (per-line placeholder progress bars).
- Bottom row: Low Stock Alerts panel + Recent Activity timeline (from audit_log).
- Inventory table sample (top 5 low-stock items).

All numeric values use `font-mono`.

## Auth pages

- `/auth`: email + password sign-in, "Forgot password" link, gated notice: "This is an invite-only platform". No public sign-up field unless invite token in URL.
- `/auth?invite=<token>`: signup form (email pre-filled from invite), sets password, on success creates account + accepts invite.
- `/reset-password`: standard supabase password update flow.

## Dependencies to add

- `bun add recharts` (charts)
- `bun add date-fns`
- `bun add zod react-hook-form @hookform/resolvers`
- shadcn primitives already available.

## Secrets

- `RESEND_API_KEY` — connect Resend connector (asked when we wire email).
- Cloud enables `SUPABASE_*` automatically.

## Deliverables checklist

1. Enable Lovable Cloud.
2. Add design tokens to `src/styles.css`; update `__root.tsx` head (title, description, fonts).
3. Migrations: enums → tables (with GRANTs) → `has_role` → triggers → RLS policies.
4. App shell components: `AppSidebar`, `TopBar`, `NotificationsBell`, permission hook `usePermissions`.
5. Auth pages + invite flow.
6. Dashboard route with live queries.
7. Inventory list + detail + action dialogs.
8. Production list + new-batch form.
9. Users/roles admin page (super_admin) + invite dialog.
10. Audit log viewer (management+).
11. Notifications page + realtime bell.
12. Placeholder pages for Procurement, Events, Reports.
13. Connect Resend, wire invite + low-stock emails via server fn.
14. Seed a handful of demo inventory items (via migration, not code).

## Out of scope for v1 (noted for future)

- Procurement workflows (requests, approvals, deliveries).
- Events module full functionality.
- Report exports (PDF/Excel).
- 2FA, QR/barcode scanning, supplier performance analytics.
- Password reset via Resend template (uses Supabase default email for now).

Ready to implement on approval.