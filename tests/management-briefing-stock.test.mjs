import assert from "node:assert/strict";
import test from "node:test";
import { evaluateStockCoverage } from "../src/lib/management-briefing-stock.ts";

const items = [
  { id: "a", sku: "FG-A", name: "Orange Juice", category: "finished_good", unit: "bottle" },
  { id: "b", sku: "RM-B", name: "Tigernut", category: "raw_material", unit: "bucket" },
  { id: "c", sku: "PK-C", name: "Bottle", category: "packaging", unit: "piece" },
];
const locations = [
  { id: "central", name: "Main Store", is_default: true },
  { id: "shop", name: "Shop 1", is_default: false },
];
const policies = [
  { item_id: "a", location_id: "central", critical_level: 1, reorder_level: 4 },
  { item_id: "b", location_id: "central", critical_level: 0, reorder_level: 2 },
  { item_id: "a", location_id: "shop", critical_level: 1, reorder_level: 3 },
];
const balances = [
  { item_id: "a", location_id: "central", on_hand: 1 },
  { item_id: "b", location_id: "central", on_hand: 5 },
  { item_id: "a", location_id: "shop", on_hand: 2 },
];

test("Central coverage includes all active categories but never invents a threshold", () => {
  const result = evaluateStockCoverage({
    items,
    locations,
    policies,
    balances,
    scope: "central",
  });
  assert.equal(result.trackedPairs, 3);
  assert.equal(result.configuredPairs, 2);
  assert.equal(result.unconfiguredPairs, 1);
  assert.equal(result.lowStock.length, 1);
  assert.deepEqual(
    result.lowStock.map((line) => line.name),
    ["Orange Juice"],
  );
  assert.equal(result.lowStock[0].critical, true);
});

test("All-location coverage includes relevant shop stock without cloning all raw items", () => {
  const result = evaluateStockCoverage({
    items,
    locations,
    policies,
    balances,
    scope: "all",
  });
  assert.equal(result.trackedPairs, 4);
  assert.equal(result.configuredPairs, 3);
  assert.equal(result.unconfiguredPairs, 1);
  assert.deepEqual(
    result.lowStock.map((line) => line.locationName),
    ["Main Store", "Shop 1"],
  );
  assert.equal(result.lowStock[1].critical, false);
});

test("A configured item with no movement row is zero, not omitted", () => {
  const result = evaluateStockCoverage({
    items,
    locations,
    policies,
    balances: balances.filter((line) => line.item_id !== "a" || line.location_id !== "central"),
    scope: "central",
  });
  assert.equal(result.lowStock[0].onHand, 0);
  assert.equal(result.lowStock[0].critical, true);
});
