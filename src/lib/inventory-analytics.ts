// Helpers to derive avg daily usage, days-to-depletion, and recommended reorder qty
// from a movement history. "Usage" = quantity leaving stock (negative net movements).

export interface MovementLite {
  type: string;
  quantity: number;
  created_at: string;
}

const USAGE_TYPES = new Set([
  "stock_out",
  "production_consume",
  "damaged",
  "expired",
  "wastage",
  "transfer",
]);

export function computeUsageStats(movements: MovementLite[], windowDays = 30) {
  const cutoff = Date.now() - windowDays * 86400_000;
  let totalUsed = 0;
  for (const m of movements) {
    if (!USAGE_TYPES.has(m.type)) continue;
    if (new Date(m.created_at).getTime() < cutoff) continue;
    totalUsed += Math.abs(Number(m.quantity) || 0);
  }
  const avgDaily = totalUsed / windowDays;
  return { totalUsed, avgDaily, windowDays };
}

export function daysUntilDepletion(currentQty: number, avgDaily: number) {
  if (!avgDaily || avgDaily <= 0) return null;
  return Math.max(0, Math.floor(currentQty / avgDaily));
}

export function recommendReorder(
  avgDaily: number,
  currentQty: number,
  reorderLevel: number | null,
  coverDays = 30,
) {
  if (!avgDaily || avgDaily <= 0) {
    // Fallback: bring stock up to 2x reorder level
    if (reorderLevel && currentQty < reorderLevel) return Math.max(reorderLevel * 2 - currentQty, reorderLevel);
    return 0;
  }
  const target = avgDaily * coverDays;
  return Math.max(0, Math.ceil(target - currentQty));
}

export function monthlyBuckets(movements: MovementLite[], months = 6) {
  const now = new Date();
  const buckets: { key: string; label: string; used: number; received: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleString(undefined, { month: "short" }),
      used: 0,
      received: 0,
    });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const m of movements) {
    const d = new Date(m.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const b = byKey.get(key);
    if (!b) continue;
    const q = Math.abs(Number(m.quantity) || 0);
    if (USAGE_TYPES.has(m.type)) b.used += q;
    else if (m.type === "stock_in" || m.type === "production_output") b.received += q;
  }
  return buckets;
}
