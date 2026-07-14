import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Boxes, FlaskConical, AlertTriangle, TrendingUp } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

interface Stats {
  totalItems: number;
  lowStock: number;
  batchesToday: number;
  outputToday: number;
}

function DashboardPage() {
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
    Array<{ id: string; sku: string; name: string; quantity: number; reorder_level: number | null; unit: string }>
  >([]);

  useEffect(() => {
    async function load() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const iso = today.toISOString();

      const [{ count: itemsCount }, { data: lowRows }, { data: batches }] = await Promise.all([
        supabase.from("inventory_items").select("*", { count: "exact", head: true }),
        supabase
          .from("inventory_items")
          .select("id, sku, name, quantity, reorder_level, unit")
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

      setLowStockItems(low.slice(0, 6));

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
          <CardHeader><CardTitle className="text-base">Low stock</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {lowStockItems.length === 0 && (
              <p className="text-sm text-muted-foreground">All items above threshold.</p>
            )}
            {lowStockItems.map((it) => (
              <div key={it.id} className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0">
                <div>
                  <p className="font-medium">{it.name}</p>
                  <p className="text-[11px] text-muted-foreground font-mono">{it.sku}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono">{Number(it.quantity).toLocaleString()} {it.unit}</p>
                  <Badge variant="outline" className="mt-0.5 text-[10px] border-brand-orange/40 text-brand-orange">
                    below {Number(it.reorder_level).toLocaleString()}
                  </Badge>
                </div>
              </div>
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
