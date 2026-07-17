
# Change Set 1 — Navigation strip + single-stock-truth reads

Scope is deliberately narrow so the whole set can land in one revertible commit. No schema changes, no data mutations, no new features. Two follow-up commits (architecture migration, workflow slices) are scoped but not executed here.

---

## 1. Scope / navigation strip (frontend only)

Edit `src/components/AppShell.tsx` only. No route file is deleted in this commit — we hide entries so a revert is a one-file diff and deep links keep working while we validate.

### FULL_NAV changes
- Remove: `Sales orders` (`/sales`), `Purchases` (`/purchases`), `Reports` (`/reports`).
- Remove: no `Procurement` entry exists in `FULL_NAV` today, but `src/routes/_authenticated/procurement.tsx` is a duplicate placeholder — flag it for deletion in the follow-up commit (not this one, to keep the diff to `AppShell.tsx`).
- Retain: Dashboard, Inventory (rename label to **Central Stock**), Recipes/BOM, Production, Dispatches (rename label to **Transfers / Dispatches**), Shops, Daily counts, Stock requests, Bulk clients (gated), Suppliers, Users (gated), Audit (gated). Notifications already lives in the header bell — leave it.

### Role gating additions
- Gate `Recipes / BOM` behind `CAN_MANAGE_RECIPES` (currently unconditional).
- Gate `Production` behind `CAN_RECORD_PRODUCTION`.
- Gate `Dispatches` behind `CAN_DISPATCH`.
- Gate `Daily counts` and `Shops` behind `CAN_MANAGE_SHOPS ∪ shop_supervisor`.
- Suppliers already visible to all; gate behind `CAN_MANAGE_PURCHASES` to match PRD (procurement-only view).

### Shop 1 (supervisor) simplified nav
Replace `SUPERVISOR_NAV` with a labelled, forward-compatible set that only links to screens that exist today, and shows disabled placeholders for the three unbuilt Shop 1 slices so the shape is visible without pretending they work:

```
Today          → /dashboard        (active)
Daily counts   → /shop-counts      (active)
Stock requests → /requests         (active)
— Sales         (disabled, tooltip: "Coming in Shop 1 sales slice")
— Closing       (disabled, tooltip: "Coming in Shop 1 closing slice")
```

Disabled entries render as muted `<span>` (not `<Link>`) so there is no dead route to 404. Add a small "Shop 1 pilot" caption above the list. No route files, no permissions constants added.

### What is explicitly NOT touched this commit
- `src/routes/_authenticated/{sales,purchases,reports,procurement}.tsx` remain on disk (unreachable from nav). Delete + `CommandPalette` cleanup ships in the follow-up so this commit stays UI-only.

---

## 2. Single stock truth — read migration (no schema change)

### Current defect (must flag before doing anything else)
`v_item_stock` exposes `on_hand` but **no `unit`, `is_active`, `supplier_id`, `default_location_id`, `updated_at`** and is not location-aware. Many components today read `inventory_items.quantity` alongside metadata in a single query. A blind swap to the view breaks those screens. Two safe options exist; **Option A** is what this plan adopts because it requires no SQL:

- **Option A (this commit):** keep querying `inventory_items` for metadata, but derive the displayed/validated balance from a **separate `v_item_stock` fetch keyed by `item_id`**, and stop reading `inventory_items.quantity` anywhere in app code. A tiny helper `useItemStock(ids)` (in `src/lib/stock.ts`) batches the view lookup and returns `Map<item_id, on_hand>`.
- **Option B (deferred to commit 2):** extend `v_item_stock` with `unit, is_active, sku, name, category, supplier_id, default_location_id` and switch queries wholesale. Requires a migration; out of scope now.

### Exhaustive list of code paths to migrate in this commit
Read sites of `inventory_items.quantity` (must switch to `v_item_stock.on_hand` via the helper):

1. `src/routes/_authenticated/inventory/index.tsx` (list; currently already joins the view but still surfaces `.quantity` naming — normalize)
2. `src/routes/_authenticated/inventory/$itemId.tsx` (on-hand, depletion, reorder calc)
3. `src/routes/_authenticated/dashboard.tsx` (low stock KPI, depletion cards)
4. `src/routes/_authenticated/requests.tsx` list + `src/components/requests/RequestDialog.tsx` (available check)
5. `src/components/dispatches/DispatchDialog.tsx` (line availability)
6. `src/components/dispatches/ReturnDialog.tsx` (display only — read via helper)
7. `src/components/inventory/MovementDialog.tsx` (header on-hand)
8. `src/components/inventory/StockCountDialog.tsx` (variance calc — critical, this one currently drives an `adjustment` movement using stale `.quantity`)
9. `src/components/production/RecordProductionDialog.tsx` (ingredient availability check)
10. `src/components/CommandPalette.tsx` (search result on-hand chip)
11. `src/lib/mcp/tools/search-inventory-items.ts` and `list-low-stock-items.ts` (MCP output)
12. `src/routes/_authenticated/recipes.tsx` display (no quantity read today — verify)

Validation logic (client-side "insufficient stock" hints) all reads from the helper. The **authoritative** validation stays server-side in the existing RPCs (`create_dispatch`, `record_production`, `approve_stock_request`, `fulfill_sales_order`) — those already read `inventory_items.quantity` or `v_item_stock`; we leave the RPC bodies untouched this commit and note the split-truth in Section 3.

### Double-counting concern
`apply_movement` still writes to `inventory_items.quantity` on every insert. `v_item_stock` is defined as `SUM(signed movements)`. As long as **no other code path** writes to `inventory_items.quantity` (verified: only the trigger does), the two are redundant but consistent. The trigger stays in place so RPC-side validations that still read `.quantity` keep working. Commit 2 removes the trigger's quantity write in the same migration that switches those RPCs to `v_item_stock`.

Rule enforced in this commit: **no app code reads `inventory_items.quantity`**. Add an ESLint `no-restricted-syntax` rule matching `.select('...quantity...')` on `inventory_items` to prevent regressions (or, if too noisy, a code comment + PR checklist entry).

### Explicitly NOT in this commit
- No changes to `apply_movement`, no changes to any RPC, no view redefinition, no location filtering, no data backfill.

---

## 3. Architecture blueprint (documentation only — commit as `.lovable/architecture.md`)

Written now, implemented in subsequent commits. Use **Africa/Lagos** for every business date via `AT TIME ZONE 'Africa/Lagos'` in views/RPCs; never trust client `new Date()` for a business day.

### Minimum schema for MVP (target state, not applied now)
- `locations` (already exists) — add `kind ∈ {factory, central_store, shop, quarantine, in_transit}`, `shop_id` FK nullable. Seed: Factory, Central Store, Shop 1, Shop 1 Quarantine, In-Transit(Shop 1).
- `v_item_stock_by_location(item_id, location_id, on_hand)` — replaces flat `v_item_stock`; flat view kept as `SUM` rollup for back-compat.
- **Balanced transfers:** repurpose `dispatches` with states `requested → approved → picked → in_transit → received → closed`; each state transition posts paired `stock_out(from_location)` + `stock_in(to_location=in_transit)` then `stock_out(in_transit)` + `stock_in(destination)` on receipt. Discrepancy = receipt qty ≠ picked qty → auto-create `stock_discrepancies` row for Inventory to resolve.
- **Quarantined returns:** returns move stock into `Shop 1 Quarantine` location, not back to sellable. Release RPC (`release_from_quarantine`) requires Inventory Manager + MD role check and posts transfer to central store or `wastage`.
- **Shared shop session + attendant attribution:** new tables `shop_sessions(shop_id, opened_at, closed_at, opened_by)` and `shop_session_attendants(session_id, user_id, pin_verified_at)`. Every `sale` movement carries `session_id` + `effective_attendant_id`.
- **Sales / payments / closing:** `shop_sales(id, session_id, attendant_id, client_ref_id UNIQUE, occurred_at, ...)`, `shop_sale_lines(sale_id, item_id, qty, unit_price)`, `shop_sale_payments(sale_id, method ∈ {cash,transfer,pos,bulk_credit,other}, amount, reference)` — split payments supported by multiple rows. Closing = existing `shop_stock_counts` + a new `shop_cash_reconciliations(session_id, expected, counted, variance, deposit_ref)`.
- **Idempotent offline sync:** every offline-originated row carries `client_ref_id UUID UNIQUE` (per table). Sync endpoint uses `INSERT ... ON CONFLICT (client_ref_id) DO NOTHING RETURNING id`. Conflict/failed state surfaced via new `sync_events` audit table.
- **Audit:** already have `audit_log`; add index on `(entity, entity_id, created_at DESC)`.

### Now vs later split
- **Now (this commit):** navigation strip, read migration only.
- **Commit 2 (schema foundation):** locations kind + shop link, `v_item_stock_by_location`, extend `v_item_stock` columns, drop `.quantity` writes from `apply_movement`, delete dead route files + CommandPalette entries for `/sales|/purchases|/reports|/procurement`.
- **Commit 3 (transfers + quarantine):** dispatch state machine, discrepancy table, quarantine location + RPC.
- **Commit 4 (Shop 1 sessions + sales slice):** sessions, attendants, sales/payments, closing reconciliation, offline `client_ref_id` on sales.
- **Commit 5+ (Tigernut production hardening, bulk, notifications).**

---

## 4. Verification for this commit

### Automated
- `bunx tsgo --noEmit` — must pass (helper adds new types).
- `bun run build` (harness auto-runs) — must pass; no route imports broken.
- Manual grep gate: `rg "inventory_items[^)]*\.select\([^)]*quantity" src` returns **zero** matches.
- Playwright smoke: sign in as super_admin, open `/inventory`, `/inventory/<id>`, `/dashboard`, `/dispatches` (new dispatch dialog), `/requests` (new request dialog), `/shop-counts` — screenshot each; confirm on-hand values match `SELECT on_hand FROM v_item_stock` for one sampled item.
- Playwright smoke as `shop_supervisor`: confirm nav shows only Today / Daily counts / Stock requests + two disabled entries.

### Rollback
Single revert of the commit restores prior nav and quantity reads. No DB change, no data change → zero-risk revert.

### PRD mapping
- Nav strip → Scope controls ("hide/remove placeholder or backlog modules"; "do not claim a workflow is complete when only tables/RPCs exist").
- Shop 1 nav shape → Pilot boundary + Shop flow (Today/Sales/Closing shape without fake screens).
- Read migration → Inventory rules ("one immutable ledger is the only stock truth"; "never trust cached quantity on the item master"). Acceptance: every on-hand number visible in the UI is derivable from `v_item_stock` in a fresh SQL check.
- Architecture doc → Scope controls ("document the location ledger and offline/sync architecture before implementation").

---

## Flagged current defects that could make even the nav-only change unsafe

1. **`StockCountDialog` computes `delta = physical - inventory_items.quantity` and posts an `adjustment` movement.** After the `.quantity` field drifts from `v_item_stock` (e.g. if any RPC ever inserts a movement without the trigger), variance is wrong and the ledger gets a bogus adjustment. Even in a nav-only commit, we should switch this one dialog's read to `v_item_stock.on_hand` in the same commit — it's the highest-risk read site. Included in the migration list above.
2. **`v_item_stock` lacks `unit`.** Every migrated read still needs `inventory_items.unit`; the helper must join or return `{ on_hand, unit }` by hitting both. Called out in the helper design.
3. **`src/routes/_authenticated/procurement.tsx` + `/sales` + `/purchases` + `/reports` routes remain reachable via typed URL** after nav hide. Acceptable for one commit (revertibility) but users bookmarking them see stubs. Follow-up commit deletes files and adds `notFoundComponent` redirects.

If any of these three feel blocking, tell me and I'll fold the file deletions into this commit instead of the next.
