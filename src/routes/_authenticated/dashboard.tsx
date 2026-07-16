import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Boxes, FlaskConical, AlertTriangle, TrendingUp } from "lucide-react";
import {
  computeUsageStats,
  daysUntilDepletion,
  recommendReorder,
} from "@/lib/inventory-analytics";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

interface Stats {
  totalItems: number;
  lowStock: number;
  batchesToday: number;
  outputToday: number;
}

interface PendingClosing {
  shop_id: string;
  shop_name: string;
  count_date: string;
  opening_id: string;
  closing_id: string | null;
}

function DashboardPage() {
  const [pendingClosings, setPendingClosings] = useState<PendingClosing[]>([]);
  const [stats, setStats] = useState<Stats>({
    totalItems: 0,
    lowStock: 0,
    batchesToday: 0,
    outputToday: 0,
  });
  const [recentBatches, setRecentBatches] = useState<
    Array<{ id: string; batch_number: string; produced_at: string; quantity_produced: number; item_name: string | null }>
  >([]);
  const [lowStockItems, setLowStockItems] = useState<
    Array<{
      id: string;
      sku: string;
      name: string;
      quantity: number;
      reorder_level: number | null;
      min_level: number | null;
      unit: string;
      avgDaily: number;
      daysLeft: number | null;
      reorderQty: number;
    }>
  >([]);

  useEffect(() => {
    async function load() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const iso = today.toISOString();
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();

      const [{ count: itemsCount }, { data: lowRows }, { data: batches }] = await Promise.all([
        supabase.from("inventory_items").select("*", { count: "exact", head: true }),
        supabase
          .from("inventory_items")
          .select("id, sku, name, quantity, reorder_level, min_level, unit")
          .not("reorder_level", "is", null)
          .order("quantity", { ascending: true })
          .limit(100),
        supabase
          .from("production_batches")
          .select("id, batch_number, produced_at, quantity_produced, inventory_items!production_batches_product_item_id_fkey(name)")
          .gte("produced_at", iso)
          .order("produced_at", { ascending: false }),
      ]);

      const low = ((lowRows ?? []) as any[]).filter(
        (r) => r.reorder_level !== null && Number(r.quantity) <= Number(r.reorder_level),
      );
      const topLow = low.slice(0, 6);

      // Batch-load 30d movements for the top low-stock items to compute usage
      let byItem = new Map<string, any[]>();
      if (topLow.length) {
        const ids = topLow.map((r) => r.id);
        const { data: moves } = await supabase
          .from("inventory_movements")
          .select("item_id, type, quantity, created_at")
          .in("item_id", ids)
          .gte("created_at", since);
        byItem = new Map();
        for (const m of (moves ?? []) as any[]) {
          const arr = byItem.get(m.item_id) ?? [];
          arr.push(m);
          byItem.set(m.item_id, arr);
        }
      }

      const enriched = topLow.map((r) => {
        const ms = byItem.get(r.id) ?? [];
        const s = computeUsageStats(ms);
        const d = daysUntilDepletion(Number(r.quantity), s.avgDaily);
        const reorderQty = recommendReorder(s.avgDaily, Number(r.quantity), r.reorder_level);
        return { ...r, avgDaily: s.avgDaily, daysLeft: d, reorderQty };
      });

      setLowStockItems(enriched);

      const outputToday = ((batches ?? []) as any[]).reduce(
        (sum, b) => sum + Number(b.quantity_produced ?? 0),
        0,
      );

      setStats({
        totalItems: itemsCount ?? 0,
        lowStock: low.length,
        batchesToday: batches?.length ?? 0,
        outputToday,
      });

      setRecentBatches(
        ((batches ?? []) as any[]).slice(0, 5).map((b) => ({
          id: b.id,
          batch_number: b.batch_number,
          produced_at: b.produced_at,
          quantity_produced: Number(b.quantity_produced),
          item_name: b.inventory_items?.name ?? null,
        })),
      );
    }
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">Live operations across inventory and production.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="SKUs tracked" value={stats.totalItems} icon={Boxes} />
        <KpiCard
          label="Low stock alerts"
          value={stats.lowStock}
          icon={AlertTriangle}
          accent={stats.lowStock > 0 ? "warn" : undefined}
        />
        <KpiCard label="Batches today" value={stats.batchesToday} icon={FlaskConical} />
        <KpiCard
          label="Output today"
          value={stats.outputToday.toLocaleString()}
          suffix="units"
          icon={TrendingUp}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Low stock intelligence</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {lowStockItems.length === 0 && (
              <p className="text-sm text-muted-foreground">All items above threshold.</p>
            )}
            {lowStockItems.map((it) => (
              <Link
                key={it.id}
                to="/inventory/$itemId"
                params={{ itemId: it.id }}
                className="block border-b last:border-0 pb-3 last:pb-0 hover:bg-muted/40 -mx-2 px-2 rounded-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{it.name}</p>
                    <p className="text-[11px] text-muted-foreground font-mono">{it.sku}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-mono text-sm">
                      {Number(it.quantity).toLocaleString()}
                      <span className="text-muted-foreground"> / {Number(it.reorder_level).toLocaleString()} {it.unit}</span>
                    </p>
                    <Badge variant="outline" className="mt-0.5 text-[10px] border-brand-orange/40 text-brand-orange">
                      {it.daysLeft !== null ? `~${it.daysLeft}d left` : "no usage data"}
                    </Badge>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-muted-foreground">
                  <span>avg <span className="font-mono">{it.avgDaily.toFixed(1)}</span>/day</span>
                  {it.reorderQty > 0 && (
                    <span>
                      reorder ~<span className="font-mono text-brand-orange">{it.reorderQty.toLocaleString()}</span> {it.unit}
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Batches today</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {recentBatches.length === 0 && (
              <p className="text-sm text-muted-foreground">No batches recorded today.</p>
            )}
            {recentBatches.map((b) => (
              <div key={b.id} className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0">
                <div>
                  <p className="font-medium">{b.item_name ?? "—"}</p>
                  <p className="text-[11px] text-muted-foreground font-mono">{b.batch_number}</p>
                </div>
                <p className="font-mono text-sm">{b.quantity_produced.toLocaleString()}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  suffix,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number | string;
  suffix?: string;
  icon: typeof Boxes;
  accent?: "warn";
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className="mt-2 text-3xl font-semibold font-mono tabular-nums">
              {value}
              {suffix && <span className="text-sm font-normal text-muted-foreground ml-1">{suffix}</span>}
            </p>
          </div>
          <div className={accent === "warn"
            ? "size-9 rounded-md bg-brand-orange/10 text-brand-orange flex items-center justify-center"
            : "size-9 rounded-md bg-muted text-muted-foreground flex items-center justify-center"}>
            <Icon className="size-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
