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
- `v_item_stock(item_id, on_hand, ...)` — SUM of signed movements per item.

Target additions:

- Extend `locations` with `kind location_kind` where
  `location_kind ∈ {factory, central_store, shop, quarantine, in_transit}`
  and nullable `shop_id UUID REFERENCES shops(id)`. Seed: Factory, Central
  Store, Shop 1, Shop 1 Quarantine, In-Transit(Shop 1).
- `inventory_movements.location_id` is already present but not enforced —
  make it `NOT NULL` in a future migration once every writer supplies it.
- New view `v_item_stock_by_location(item_id, location_id, on_hand)` —
  same SUM logic grouped by `(item_id, location_id)`. The flat
  `v_item_stock` becomes a rollup over this view for back-compat.

**Guarantee.** No app code reads `inventory_items.quantity`. The
`apply_movement` trigger continues to maintain that column for RPC
validation until commit 2 migrates every RPC to `v_item_stock`; the
trigger's `.quantity` write is removed in the same migration to eliminate
the two-writer risk.

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

| Transition       | Movement A                     | Movement B                              |
|------------------|--------------------------------|-----------------------------------------|
| picked           | `stock_out` from source        | `stock_in` to `in_transit` location     |
| received (match) | `stock_out` from `in_transit`  | `stock_in` to destination               |
| received (short) | `stock_out` from `in_transit`  | `stock_in` to destination for received qty; **balance stays in `in_transit` until Inventory Manager resolves** |

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
   `v_item_stock_by_location`, extend `v_item_stock` columns, drop the
   `.quantity` write from `apply_movement`, delete dead route files, prune
   `CommandPalette` nav entries.
3. **Transfers + quarantine** — dispatch state machine, `stock_discrepancies`
   table, quarantine RPC.
4. **Shop 1 sessions + sales slice** — sessions, attendants, sales, payments,
   closing reconciliation, `client_ref_id` on sales.
5. **Production hardening (Tigernut)** — recipe approval gate, planned vs
   actual variance, rejects/losses.
6. **Bulk clients + notifications hardening** — MD-approved bulk pricing,
   WhatsApp escalation on critical alerts.

Everything before commit 2 is fully revertible with no data change.
