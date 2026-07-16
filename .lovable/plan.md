# Milestone 1 Build Plan — Transaction-Driven Inventory

Shift the app from manual stock editing to a **ledger model**: current stock is always derived from `inventory_movements`. Import the cleaned master data, wire sales & receipts through the same ledger, and lay down a draft BOM framework that stays inert until quantities are approved.

## 1. Master Data Import (Milestone 1 CSVs)

- Add `item_id` (text, e.g. `FG0035`) and `subcategory` on `inventory_items`; keep existing `sku` unique. Add `status` (active/inactive), `aliases` (text[]), `standard_cost`, `import_notes`.
- Extend `item_category` enum to cover: `finished_good`, `raw_material`, `packaging`, `consumable`, `semi_finished`.
- Create `locations` table (from `locations.csv`, seed `LOC0001 Main Store`) and add `location_id` to movements (nullable now, default Main Store).
- One-shot migration seeds all 214 items from `master_item_register.csv` (idempotent on `sku`). Existing seeded juice items get reconciled to their canonical `item_id`.
- Import `stock_levels.csv` as **opening balance movements** (`type = 'opening_balance'`, dated migration cut-off) so no field is hand-edited — negatives allowed but flagged.

## 2. Ledger-Computed Stock

- New movement types: `opening_balance`, `receipt`, `sale`, `waste`, `adjustment_in`, `adjustment_out`, `production_in`, `production_out` (map old ones via migration).
- Replace the `quantity` column on `inventory_items` with a **view** `v_item_stock` that sums signed movements per item & location. Existing UI reads switch to this view.
- Keep the `apply_movement` trigger for low-stock notifications, but stop mutating `inventory_items.quantity` (drop the column after backfill).
- Block manual stock edits in the UI — item form no longer exposes quantity; corrections go through an **Adjustment** dialog that writes `adjustment_in/out` with reason + approver.
- Guardrail: sale/production/dispatch RPCs reject if resulting stock would go negative unless caller has `management`/`super_admin` (mirrors existing dispatch pattern).

## 3. Customers, Sales Orders & Stock Issues

- New `customers` table (distinct from B2B `clients`; retail/outlet customers from sales history). Fields: name, type (retail/wholesale/outlet), contact, notes.
- `sales_orders` (customer, order_no, order_date, status: draft/confirmed/fulfilled/void, notes) and `sales_order_items` (FK item, qty, unit_price).
- `fulfill_sales_order(order_id)` RPC → writes `sale` movements atomically; `void_sales_order(order_id)` writes reversing movements (never deletes).
- UI: Sales module (list, create, fulfill, void) with per-customer history.

## 4. Purchasing / Receiving

- `purchase_orders` (supplier, po_no, status, expected_date) + `purchase_order_items`. Creation does **not** touch stock.
- `receive_purchase_order(po_id, lines[])` RPC → writes `receipt` movements, supports partial receipts, updates PO status.
- Works for raw materials, packaging, and consumables through the same ledger.

## 5. Recipes / BOM Framework (inert until approved)

- `recipes` (product_item_id, version, yield_quantity, yield_unit, waste_pct, status: draft/approved, approved_by, approved_at, notes) — one active approved version per product.
- `recipe_ingredients` (recipe_id, ingredient_item_id, quantity NULLABLE, unit, waste_pct NULLABLE, notes). **Nullable is intentional** for the migration framework.
- Recipe editor UI: table view per product, inline blank fields, "Request approval" only enabled when every ingredient row has a quantity + unit.
- Existing `record_production` stays available but gains a **BOM mode**: if the product has an approved recipe, ingredients auto-populate & auto-deduct; otherwise the operator enters consumption manually (current behaviour). Auto-deduction is off by default until approval.

## 6. Dashboard Rewrite

Sections (all derived from ledger + orders):
- Current stock (from `v_item_stock`), low stock, out of stock, **negative stock alerts** (dedicated card).
- Recent stock movements feed (last 20 across all types).
- Sales by customer/outlet (last 30 days), fast-moving products (top 10 by outflow).
- **Recipe readiness**: % of finished goods with approved recipe; list of products missing recipes or with blank ingredient quantities.
- **Production readiness**: approved recipes whose ingredients are all in stock.

## 7. Navigation / Permissions

- New routes: `/items` (renamed from inventory to reflect scope), `/customers`, `/sales`, `/purchases`, `/recipes`, `/adjustments`.
- Retain existing Shops/Dispatches/Stock counts/Production — production dialog gains recipe picker.
- Permission additions: `CAN_MANAGE_RECIPES`, `CAN_APPROVE_RECIPES` (management/super_admin), `CAN_MANAGE_SALES`, `CAN_MANAGE_PURCHASES`, `CAN_ADJUST_STOCK` (with approval).

## Explicitly Out of Scope (later milestones)

- Filling BOM quantities (business will do this after go-live).
- Enabling automatic production deduction.
- Costing/valuation reports.
- Milestone 2–4 packages (waiting on your upload).

## Technical Notes

- All schema changes ship in one migration with GRANTs + RLS policies scoped by role.
- Stock read path: switch every component using `inventory_items.quantity` to a hook that queries `v_item_stock`; drop the column after the switch compiles clean.
- Opening-balance import runs inside the same migration using values from `stock_levels.csv` (I'll bake them in as an INSERT ... VALUES block, tagged `source = 'milestone1_import'`).
- Data-quality issues from `data_quality_issues.csv` surface as a one-time review page under Settings → Data Quality (read-only list), so ops can resolve during go-live.

Approve to build, or tell me what to trim/re-order.
