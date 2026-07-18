# Fruithub MVP — Target Architecture (blueprint, not yet implemented)

Timezone: **Africa/Lagos**. Business dates always derived via
`(<ts> AT TIME ZONE 'Africa/Lagos')::date` in SQL views/RPCs. Never trust a
client `new Date()` for the business day.

Pilot boundary: Shop 1 (adjacent to factory) + Tigernut production. All
architecture below is designed so Shops 2–3 and other product families can
be added later without a data migration.

---

## 1. Location-aware ledger (the single stock truth)

Existing tables already hold the pieces:

- `inventory_movements` — immutable ledger. Signed inserts only; corrections
  are reversing movements, never `UPDATE`/`DELETE`.
- `v_item_stock` — SUM of signed movements per item. Live columns:
  `item_id, item_code, sku, name, category, subcategory, unit, min_level,
reorder_level, status, on_hand`. The view is **flat and not
  location-aware** — `on_hand` is a global rollup across all locations.

Current state (this commit):

- `locations` seeded with **Main Store** (default) and **Shop 1**. Kinds
  (factory / quarantine / in-transit) remain a later extension.
- `inventory_movements.location_id` is present. As of 17 July 2026 all rows
  have a non-null `location_id` (post-reset baseline). New manual movements
  MUST include `location_id` — enforced via the `record_manual_movement`
  RPC and the location-required UI.
- **`v_item_location_stock(item_id, location_id, on_hand)`** — SUM of signed
  movements grouped by (item, location). Location-aware balance reads and
  stock-out validation MUST use this view; the flat `v_item_stock` is a
  cross-location rollup for the central catalog only.
- Manual entry is funneled through two RPCs so validation is transactional:
  - `record_manual_movement(_item, _location, _type, _qty, _reason)` blocks
    the generic `transfer` type and rejects any stock-out that would drive
    the location balance below zero.
  - `record_location_stock_count(_item, _location, _physical, _reason)`
    writes a signed adjustment against a specific location with actor,
    timestamp and reason recorded in `audit_log`.
- Transfers between locations remain in the dedicated balanced dispatch /
  receipt workflow (`create_dispatch` + receipt) — never a raw negative.

**Guarantee.** No app code reads `inventory_items.quantity`. The
`apply_movement` trigger continues to maintain that column for legacy RPC
validation only; a later commit will move remaining RPCs off it.

Negative on-hand is accepted (offline-synced sales can arrive late) and
must be flagged visibly.

---

## 2. Balanced transfers (Central Store ↔ Shop)

Repurpose `dispatches` as a state machine:

```
requested → approved → picked → in_transit → received → closed
                                              └─→ discrepancy
```

Each transition posts paired movements:

| Transition       | Movement A                    | Movement B                                                                                                     |
| ---------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| picked           | `stock_out` from source       | `stock_in` to `in_transit` location                                                                            |
| received (match) | `stock_out` from `in_transit` | `stock_in` to destination                                                                                      |
| received (short) | `stock_out` from `in_transit` | `stock_in` to destination for received qty; **balance stays in `in_transit` until Inventory Manager resolves** |

Discrepancy = `received_qty ≠ picked_qty` → new
`stock_discrepancies(id, dispatch_line_id, expected, actual, status, resolved_by, resolution_movement_id)`.
Inventory Manager resolves via a `resolve_discrepancy` RPC that posts the
compensating movement (write-off / found / return-to-store).

---

## 3. Quarantined returns

Returns from a shop go to the `<shop> Quarantine` location, **not** back to
sellable. New RPC `release_from_quarantine(_line_ids uuid[], _target text,
_reason text)` requires Inventory Manager **and** MD role check; posts a
transfer to Central Store, back to the shop, or to `wastage`.

---

## 4. Shared shop session + attendant attribution

New tables:

- `shop_sessions(id, shop_id, opened_at, closed_at, opened_by)`
- `shop_session_attendants(session_id, user_id, pin_verified_at)`

Every sale/movement originating in the shop carries `session_id` and an
`effective_attendant_id` recorded via PIN or profile confirmation at the
POS keypad. No midday handover in MVP — closing the session ends the day.

---

## 5. Sales, payments, closing (Shop 1 slice)

- `shop_sales(id, session_id, attendant_id, client_ref_id UUID UNIQUE,
 occurred_at, total, status)`
- `shop_sale_lines(sale_id, item_id, qty, unit_price)`
- `shop_sale_payments(sale_id, method payment_method, amount, reference)`
  where `payment_method ∈ {cash, transfer, pos, bulk_credit, other}`.
  Split payments = multiple rows per sale.

Fulfilling a sale inserts `sale` movements at the shop location. Voids
insert compensating `adjustment_in` movements (never `DELETE`).

Closing reconciliation extends existing `shop_stock_counts` with a sibling
`shop_cash_reconciliations(session_id, expected, counted, variance,
deposit_ref, deposited_at)`. Prices are system-controlled; attendants
cannot discount (enforced by RLS on `shop_sale_lines.unit_price`).

---

## 6. Idempotent offline sync

Every offline-originated row carries `client_ref_id UUID UNIQUE` (per
table). Sync uses `INSERT ... ON CONFLICT (client_ref_id) DO NOTHING
RETURNING id`. Conflict/failed state surfaced in a new `sync_events(id,
device_id, table_name, client_ref_id, status, payload, error, created_at)`
audit table so the UI can show Online/Offline/Pending/Failed/Conflict.

Approvals, price changes, and discrepancy resolution require internet.

---

## 7. Audit

`audit_log` already exists. Add index `(entity, entity_id, created_at DESC)`
to make item/dispatch history retrieval cheap.

---

## Implementation order (one commit each)

1. **This commit** — navigation strip + app reads switch to `v_item_stock`.
   No schema change.
2. **Schema foundation** — `locations.kind` + `shop_id`,
   `v_item_stock_by_location` (gated on the location backfill described in
   §1), and drop the `.quantity` write from `apply_movement` once every RPC
   reads from `v_item_stock`. (The four placeholder routes — Sales,
   Purchases, Reports, Procurement — were already removed in commit
   5d6b8c79 and are not part of this step.)
3. **Transfers + quarantine** — dispatch state machine, `stock_discrepancies`
   table, quarantine RPC.
4. **Shop 1 sessions + sales slice** — sessions, attendants, sales, payments,
   closing reconciliation, `client_ref_id` on sales.
5. **Production hardening (Tigernut)** — recipe approval gate, planned vs
   actual variance, rejects/losses.
6. **Bulk clients + notifications hardening** — MD-approved bulk pricing,
   WhatsApp escalation on critical alerts.

Everything before commit 2 is fully revertible with no data change.

---

## 8. Secure bootstrap & invitations

- Public sign-up is disabled once any user has an application role. The auth
  UI calls the SECURITY DEFINER RPC `bootstrap_allowed()` (returns `true`
  only when `user_roles` is empty) to decide whether to expose the "Create
  super admin" path. RLS-blocked anonymous counts are never used again for
  this decision.
- The `handle_new_user` trigger is the enforcement point: it accepts the
  first user as `super_admin`, then requires a matching unaccepted,
  unexpired invite in `user_invites`. Sign-ups without a valid invite raise
  and roll the auth insert back — no silent readonly account is created.
- Admin-initiated invites remain the only path for new accounts.

---

## 9. Reversible user lifecycle

- Pending invitations are cancelled by setting `cancelled_at`, `cancelled_by`
  and a required `cancel_reason`; invitation rows are never deleted. Both the
  public validation query and `handle_new_user` require `cancelled_at IS NULL`.
- `cancel_user_invite()` and `set_user_active_status()` are the authoritative
  SECURITY DEFINER mutations. Both require an active `super_admin` or `admin`
  and write the reason, actor and before/after state to `audit_log` in the same
  transaction. A database trigger rejects direct changes to the protected
  cancellation and `is_active` fields, including self-reactivation attempts.
- User removal in the MVP means reversible application-access deactivation via
  `profiles.is_active`. Auth identities, profiles, roles and historical record
  ownership are retained.
- Self-deactivation and deactivation of the last active Super Admin are blocked.
  An Admin cannot change a Super Admin; only another Super Admin can.
- `has_role()` and `has_any_role()` require an active profile, so inactive users
  cannot satisfy role-based RLS policies. The authenticated app also checks the
  profile on entry, signs inactive users out locally and returns them to a clear
  inactive-account sign-in state.
- Deactivation does not delete or ban the underlying Supabase Auth identity.
  Policies that grant access to every authenticated identity without a role
  check remain outside this lifecycle guard and should be tightened in a later
  security-policy audit.

---

## 10. Replenishment and Purchasing MVP realignment

The operational build now has two deliberately separate workflows:

- **Replenishment** (`/replenishment`) is the internal Shop 1 movement from
  Main Store. A request is reviewed, issued as a dispatch, and independently
  confirmed at the shop. Approval never changes stock. A mismatch creates a
  `replenishment_discrepancies` row and only the confirmed quantity is posted into
  the Shop 1 location ledger.
- **Purchasing** (`/purchasing`) is external supplier acquisition. It has one
  workspace with only Needs and Orders tabs. Procurement records quotes,
  payment evidence and delivery; Inventory independently inspects the delivery.
  Only accepted quantity posts a location-specific `receipt` movement.

`stock_level_policies` is the sole source of automatic low-stock decisions.
Each item/location policy must satisfy `target > reorder >= critical >= 0` and
routes to `purchasing`, `production`, or `replenishment`. Legacy zero values on
`inventory_items` are not policies and must never generate automatic needs.

`purchase_needs` is the deduplicated routed work queue. One open automatic need
may exist for an item/location/route. A policy is evaluated immediately when it
is configured and after each location movement. Shop 1 replenishment uses the
latest submitted closing count plus dispatches already in transit; the ledger is
the fallback before a closing exists.

Purchasing transitions are audited SECURITY DEFINER operations. While
`purchasing_settings.routine_approval_threshold_naira` is null, every quoted
order requires `super_admin`/`management` (the current MD role mapping).
Procurement cannot approve a purchase and the user who sourced or recorded a
delivery cannot independently receive it. Submitted purchasing and
replenishment records cannot be deleted; cancellation changes status and writes
an audit event.

Offline provider work remains out of this build, but request, order, dispatch
and receipt mutations accept unique client references and are idempotent so a
later offline queue can retry safely.
