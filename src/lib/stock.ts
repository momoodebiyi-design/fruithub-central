/**
 * Single source of truth for on-hand stock.
 *
 * All UI code MUST derive current on-hand from `v_item_stock` (which sums
 * signed inventory_movements). Never read `inventory_items.quantity` in
 * application code — that column is maintained by the `apply_movement`
 * trigger for legacy RPC validation only and can drift.
 */
import { supabase } from "@/integrations/supabase/client";

export async function fetchStockMap(itemIds: string[]): Promise<Map<string, number>> {
  const ids = Array.from(new Set(itemIds.filter(Boolean)));
  if (ids.length === 0) return new Map();
  const { data } = await (supabase as any)
    .from("v_item_stock")
    .select("item_id, on_hand")
    .in("item_id", ids);
  const map = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ item_id: string; on_hand: number | null }>) {
    map.set(row.item_id, Number(row.on_hand ?? 0));
  }
  for (const id of ids) if (!map.has(id)) map.set(id, 0);
  return map;
}

export async function fetchOnHand(itemId: string): Promise<number> {
  const m = await fetchStockMap([itemId]);
  return m.get(itemId) ?? 0;
}
