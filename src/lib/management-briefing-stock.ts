export type BriefingItem = {
  id: string;
  sku: string | null;
  name: string;
  category: string;
  unit: string;
};

export type BriefingLocation = {
  id: string;
  name: string;
  is_default: boolean;
};

export type BriefingPolicy = {
  item_id: string;
  location_id: string;
  critical_level: number;
  reorder_level: number;
};

export type BriefingBalance = {
  item_id: string;
  location_id: string;
  on_hand: number;
};

export type LowStockLine = {
  itemId: string;
  sku: string | null;
  name: string;
  category: string;
  unit: string;
  locationId: string;
  locationName: string;
  onHand: number;
  reorderLevel: number;
  criticalLevel: number;
  critical: boolean;
};

export type StockCoverage = {
  lowStock: LowStockLine[];
  trackedPairs: number;
  configuredPairs: number;
  unconfiguredPairs: number;
  locationNames: string[];
};

function pairKey(locationId: string, itemId: string) {
  return `${locationId}:${itemId}`;
}

/**
 * Central covers every active catalogue item. Outside Central we assess only
 * item/location pairs with a balance or an explicit policy: raw ingredients do
 * not automatically become Shop 1/2 products. Missing policies are never
 * treated as a zero reorder threshold or a low-stock alert.
 */
export function evaluateStockCoverage(input: {
  items: BriefingItem[];
  locations: BriefingLocation[];
  policies: BriefingPolicy[];
  balances: BriefingBalance[];
  scope: "central" | "all";
}): StockCoverage {
  const central =
    input.locations.find((location) => location.is_default) ??
    input.locations.find((location) => location.name.toLowerCase() === "main store");
  if (!central) throw new Error("Central inventory location is unavailable");
  const locations = input.scope === "all" ? input.locations : [central];
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const relevant = new Set(input.items.map((item) => pairKey(central.id, item.id)));

  if (input.scope === "all") {
    for (const row of [...input.policies, ...input.balances]) {
      if (locationById.has(row.location_id) && itemById.has(row.item_id)) {
        relevant.add(pairKey(row.location_id, row.item_id));
      }
    }
  }

  const policies = new Map(
    input.policies.map((policy) => [pairKey(policy.location_id, policy.item_id), policy]),
  );
  const balances = new Map(
    input.balances.map((balance) => [
      pairKey(balance.location_id, balance.item_id),
      Number(balance.on_hand),
    ]),
  );
  const lowStock: LowStockLine[] = [];
  let configuredPairs = 0;
  let unconfiguredPairs = 0;

  for (const key of relevant) {
    const [locationId, itemId] = key.split(":");
    const item = itemById.get(itemId);
    const location = locationById.get(locationId);
    if (!item || !location) continue;
    const policy = policies.get(key);
    if (!policy) {
      unconfiguredPairs += 1;
      continue;
    }
    configuredPairs += 1;
    const onHand = balances.get(key) ?? 0;
    if (!Number.isFinite(onHand) || onHand > Number(policy.reorder_level)) continue;
    lowStock.push({
      itemId,
      sku: item.sku,
      name: item.name,
      category: item.category,
      unit: item.unit,
      locationId,
      locationName: location.name,
      onHand,
      reorderLevel: Number(policy.reorder_level),
      criticalLevel: Number(policy.critical_level),
      critical: onHand <= Number(policy.critical_level),
    });
  }

  lowStock.sort(
    (a, b) =>
      Number(b.critical) - Number(a.critical) ||
      a.category.localeCompare(b.category) ||
      a.locationName.localeCompare(b.locationName) ||
      a.name.localeCompare(b.name),
  );
  return {
    lowStock,
    trackedPairs: relevant.size,
    configuredPairs,
    unconfiguredPairs,
    locationNames: locations.map((location) => location.name),
  };
}
