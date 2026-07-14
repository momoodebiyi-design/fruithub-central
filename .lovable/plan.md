
Got it — replacing the "Events" concept with **Shops & Dispatches** (your own retail outlets). Vendors/wholesale customers stay parked for later. Rest of the plan is unchanged.

## Phase 1 — Movement-first inventory + bulk import (this turn)

1. **Item detail page** (`/inventory/$itemId`): current stock, min/reorder, supplier, location, photo, full movement timeline (who / when / type / qty / reason / linked batch), monthly consumption chart, avg daily usage, est. days to depletion.
2. **Movement-only editing**: quantity field removed from item create/edit dialog. All stock changes go through movement actions. Movement types renamed in UI to your list (Receive, Use in production, Dispatch to shop, Return from shop, Damaged, Expired, Wasted, Adjustment).
3. **Stock audit / count**: enter physical count + reason → system records an adjustment movement with the delta.
4. **Smarter low-stock card** on dashboard: current, min, avg daily usage, est. days left, recommended reorder qty.
5. **Bulk import** (`.xlsx` / `.csv`): upload → map columns → preview → import. Downloadable template. Existing SKUs update; new SKUs create; opening stock recorded as `stock_in` so history stays clean.
6. **Global search** (⌘K): items, batches, suppliers.

## Phase 2 — Shops + Dispatches + Approval workflow *(revised)*

- **Shops** table: name, location, manager, contact, is_active. CRUD UI.
- **Suppliers** UI (table already exists).
- **Dispatches**: record a shipment to a shop
  - Header: shop, date, dispatched_by, vehicle/notes
  - Lines: item + quantity → each line records a `stock_out` (type `transfer`, `to_shop_id` on the movement) so inventory decrements atomically
  - Status: `draft` → `dispatched` → `received` (shop confirms) → optional `reconciled`
  - **Returns**: from a dispatch, record returned quantities per line → `stock_in` movements linked back to the dispatch (for damaged/unsold stock coming back)
- **Per-shop ledger**: what each shop has received / returned / net on-hand at that shop over time.
- **Approval workflow**: `stock_requests` table. Production/shop staff request stock; Inventory Officer approves; approval creates the movement (or dispatch). Rejections logged.
- Parking lot (Phase 5+): "External customers / vendors / wholesale" — separate entity type, invoicing-shaped, distinct from internal shops.

## Phase 3 — Procurement + activity feed
Purchase requests, POs, receiving auto-`stock_in`, auto-PR when item hits reorder level, unified activity feed.

## Phase 4 — Reports + analytics
CSV exports (valuation, consumption by month, most used, dead stock, waste, supplier purchases, department usage, production efficiency, **per-shop dispatches**). Predictive insights on dashboard.

## Phase 5 — Barcode/QR + action-based permissions + external customers
QR per item + scan flow, `(role, action, resource)` permission matrix, and the deferred vendor/wholesale module.

---

Data-model note: dispatches reuse `inventory_movements` under the hood (type `transfer`, plus new `to_shop_id` / `dispatch_id` columns) so per-item history stays complete and the same audit/notification triggers keep working.

Say the word and I'll start Phase 1.
