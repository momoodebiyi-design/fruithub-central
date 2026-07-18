/**
 * Single source of truth for on-hand stock.
 *
 * All UI code MUST derive current on-hand from `v_item_stock` (which sums
 * signed inventory_movements). Never read `inventory_items.quantity` in
 * application code — that column is maintained by the `apply_movement`
 * trigger for legacy RPC validation only and can drift.
 *
 * Fail-closed contract: if the ledger query fails (network, RLS denial,
 * view error), these helpers THROW `StockReadError`. Callers must catch
 * and surface an explicit "unable to load ledger balance" state — never
 * treat a failed read as zero on-hand.
 */
import { supabase } from "@/integrations/supabase/client";

export class StockReadError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "StockReadError";
  }
}

export async function fetchStockMap(itemIds: string[]): Promise<Map<string, number>> {
  const ids = Array.from(new Set(itemIds.filter(Boolean)));
  if (ids.length === 0) return new Map();
  const { data, error } = await (supabase as any)
    .from("v_item_stock")
    .select("item_id, on_hand")
    .in("item_id", ids);
  if (error) {
    throw new StockReadError(
      `Unable to load ledger balance: ${error.message ?? "unknown error"}`,
      error,
    );
  }
  const map = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ item_id: string; on_hand: number | null }>) {
    map.set(row.item_id, Number(row.on_hand ?? 0));
  }
  // Items with zero movements legitimately have no row in v_item_stock — a
  // successful query with a missing item is a real zero balance, not an error.
  for (const id of ids) if (!map.has(id)) map.set(id, 0);
  return map;
}

export async function fetchOnHand(itemId: string): Promise<number> {
  const m = await fetchStockMap([itemId]);
  return m.get(itemId) ?? 0;
}

/**
 * Location-scoped on-hand. Sums the ledger for a single (item, location).
 * Returns 0 when the item has no movements at that location.
 */
export async function fetchOnHandAtLocation(
  itemId: string,
  locationId: string,
): Promise<number> {
  const { data, error } = await (supabase as any)
    .from("v_item_location_stock")
    .select("on_hand")
    .eq("item_id", itemId)
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) {
    throw new StockReadError(
      `Unable to load location balance: ${error.message ?? "unknown error"}`,
      error,
    );
  }
  return Number(data?.on_hand ?? 0);
}

export interface StockLocation {
  id: string;
  name: string;
  location_type: string | null;
  is_default: boolean;
}

export async function fetchStockLocations(): Promise<StockLocation[]> {
  const { data, error } = await supabase
    .from("locations")
    .select("id, name, location_type, is_default")
    .eq("status", "active")
    .order("is_default", { ascending: false })
    .order("name");
  if (error) {
    throw new StockReadError(
      `Unable to load locations: ${error.message ?? "unknown error"}`,
      error,
    );
  }
  return (data ?? []) as StockLocation[];
}

