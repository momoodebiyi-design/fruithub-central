# Operational event dates — implementation contract

## Scope

Active workflows: Central stocktakes (both the full sheet and single-item count), manual
stock movements, production, dispatches, factory returns, and purchasing (quote/order
placement, supplier delivery, and Inventory inspection). Frozen shop-count and
replenishment screens remain frozen. Supplier/product setup, approval decisions, and
system-generated alerts are not backdated business events.

## Two clocks, never one editable timestamp

- **Occurred at** is the staff-entered Lagos date/time when the physical or commercial
  event happened. It drives operational date filters and exports.
- **Recorded at** is server-generated when the record enters the app. It cannot be
  backdated. Actor and correction reason stay in the audit log.
- A past Lagos calendar date requires a reason and Management/Admin authority, in
  line with the existing production/dispatch rule. Future dates are rejected.
- Approval/submission timestamps remain server-generated. Entering a historic order
  or receipt does not pretend that an approval happened earlier than it did.

## Stock reconciliation rule

The event date is not a license to overwrite current stock. A backdated stock-affecting
record must calculate its effect relative to its actual time and check for a newer posted
Central stocktake of the same item/location. The default entry path rejects a crossing.
Management/Admin may explicitly tick the override and provide a late-entry reason.
The historic movement is recorded on its actual date, with an opposite, audited
reconciliation movement immediately after the later count's effective time (entered
and audited now) so the later physical count remains authoritative
for today's balance. The original posted count is never rewritten. Every stock mutation
and date write must be atomic and idempotent. For a late physical stocktake, expected
stock is the ledger at the count time, not the ledger when the form was opened.

## Workflow meaning

| Workflow | Occurred-at meaning | Recorded-at source |
| --- | --- | --- |
| Central stocktake | Physical count completed | Server creation/submission time |
| Single-item count | Physical count completed | Server movement time |
| Manual movement | Goods actually received/used/lost/adjusted | Server movement time |
| Production | Batch physically produced | Existing batch creation time |
| Dispatch | Goods physically sent | Existing dispatch creation time |
| Factory return | Goods returned and accepted/rejected | Server return creation time |
| Supplier quote | Quote received | Server order draft creation time |
| Order placement/payment | Order actually placed/payment made | Server payment-recording time |
| Supplier delivery | Goods physically arrived | Server delivery-recording time |
| Inventory inspection | Goods inspected and accepted/rejected | Server inspection time |

Purchase need `required_date` and order `expected_date` remain planning dates, not
substitutes for actual event dates. Existing role separation for Procurement and Inventory
continues to apply. Reports must show both clocks for late entries and export the same
values they display.

## Acceptance checks

1. A same-day entry defaults to the current Lagos time; a past entry requires reason
   and authorised role; a future entry is rejected on client and server.
2. A Monday movement entered Wednesday appears under Monday in operational reports,
   with Wednesday recorded-at and actor preserved.
3. A past count uses the Monday ledger as expected stock. If a later posted count
   already covers an item, ordinary posting is blocked; an explicit manager override
   records the historic delta and an audited counter-entry without changing today's stock.
4. A return or purchase receipt increases Central stock only by accepted quantity.
5. A repeated client reference never posts stock twice; rejected/failed transactions
   leave no half-written balance or date.
6. Approval timestamps and audit event timestamps remain actual server times.

## Release gate

Run the migration and authenticated checks in a non-production copy before merging:

1. Give an item 10 units, post a Central count of 8, then enter a historic
   2-unit receipt before the count. The ordinary path must reject it.
2. Repeat with a Management/Admin override and a reason. The historic receipt
   and its opposite reconciliation must both appear in movement history; current
   Central stock must remain 8, and the original count must stay unchanged.
3. Retry each client reference: stock and audit entries must not duplicate.
4. Repeat with an inventory-only account: the override must be rejected.
5. Check an old return, stock count, and accepted supplier receipt in Reports:
   filters/export use the actual date, while entry/audit time remains visible.
6. Check production and dispatch date entry remains unchanged, and frozen shop
   sales/count screens remain inaccessible.

Do not apply this migration directly to live data without the above checks and
a current database recovery snapshot.
