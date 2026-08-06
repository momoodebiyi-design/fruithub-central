/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Boxes, FlaskConical, AlertTriangle, TrendingUp, ShoppingCart } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { CAN_APPROVE_PURCHASES, hasAny, isShopSupervisorOnly } from "@/lib/permissions";
import { ShopOperationsPaused } from "@/components/ShopOperationsPaused";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

interface Stats {
  totalItems: number;
  lowStock: number;
  batchesToday: number;
  outputToday: number;
  approvals: number;
}

function DashboardPage() {
  const session = useSession();
  const canApprovePurchases =
    hasAny(session.roles, CAN_APPROVE_PURCHASES) && !session.roles.includes("procurement");
  const [stats, setStats] = useState<Stats>({
    totalItems: 0,
    lowStock: 0,
    batchesToday: 0,
    outputToday: 0,
    approvals: 0,
  });
  const [recentBatches, setRecentBatches] = useState<
    Array<{
      id: string;
      batch_number: string;
      produced_at: string;
      quantity_produced: number;
      item_name: string | null;
    }>
  >([]);
  const [lowStockItems, setLowStockItems] = useState<
    Array<{
      id: string;
      needNumber: string;
      name: string;
      available: number;
      unit: string;
      suggested: number;
      priority: string;
      sourceType: string;
      location: string;
    }>
  >([]);

  useEffect(() => {
    async function load() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const iso = today.toISOString();
      const [
        { count: itemsCount },
        { data: routedNeeds },
        { data: batches },
        { data: approvalRows },
      ] = await Promise.all([
        supabase
          .from("inventory_items")
          .select("*", { count: "exact", head: true })
          .eq("status", "active"),
        (supabase as any)
          .from("purchase_needs")
          .select(
            "id, need_number, available_stock_snapshot, suggested_quantity, priority, source_type, inventory_items(name, unit), locations:locations!purchase_needs_location_id_fkey(name)",
          )
          .in("status", ["draft", "ready", "sourcing", "ordered"])
          .order("created_at", { ascending: false }),
        supabase
          .from("production_batches")
          .select(
            "id, batch_number, produced_at, quantity_produced, inventory_items!production_batches_product_item_id_fkey(name)",
          )
          .gte("produced_at", iso)
          .order("produced_at", { ascending: false }),
        (supabase as any)
          .from("purchase_orders")
          .select("id, submitted_by")
          .eq("workflow_status", "awaiting_approval"),
      ]);
      const activeNeeds = ((routedNeeds ?? []) as any[])
        .filter((need) => need.source_type !== "replenishment")
        .map((need) => ({
          id: need.id,
          needNumber: need.need_number,
          name: need.inventory_items?.name ?? "—",
          unit: need.inventory_items?.unit ?? "",
          available: Number(need.available_stock_snapshot ?? 0),
          suggested: Number(need.suggested_quantity ?? 0),
          priority: need.priority,
          sourceType: need.source_type,
          location: need.locations?.name ?? "—",
        }));
      setLowStockItems(activeNeeds.slice(0, 6));

      const outputToday = ((batches ?? []) as any[]).reduce(
        (sum, b) => sum + Number(b.quantity_produced ?? 0),
        0,
      );

      setStats({
        totalItems: itemsCount ?? 0,
        lowStock: activeNeeds.length,
        batchesToday: batches?.length ?? 0,
        outputToday,
        approvals: canApprovePurchases
          ? ((approvalRows ?? []) as Array<{ submitted_by: string | null }>).filter(
              (order) => order.submitted_by !== session.user?.id,
            ).length
          : 0,
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
  }, [canApprovePurchases, session.user?.id]);

  if (isShopSupervisorOnly(session.roles)) return <ShopOperationsPaused />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Live operations across inventory and production.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard label="SKUs tracked" value={stats.totalItems} icon={Boxes} />
        <KpiCard
          label="Low stock alerts"
          value={stats.lowStock}
          icon={AlertTriangle}
          accent={stats.lowStock > 0 ? "warn" : undefined}
        />
        <KpiCard
          label="Your purchase approvals"
          value={stats.approvals}
          icon={ShoppingCart}
          accent={stats.approvals > 0 ? "warn" : undefined}
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
          <CardHeader>
            <CardTitle className="text-base">Configured low-stock queues</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {lowStockItems.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No configured location policy is currently below its reorder level.
              </p>
            )}
            {lowStockItems.map((it) => (
              <Link
                key={it.id}
                to={it.sourceType === "purchasing" ? "/purchasing" : "/production"}
                className="block border-b last:border-0 pb-3 last:pb-0 hover:bg-muted/40 -mx-2 px-2 rounded-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{it.name}</p>
                    <p className="text-[11px] text-muted-foreground font-mono">
                      {it.needNumber} · {it.location}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-mono text-sm">
                      {it.available.toLocaleString()} {it.unit}
                    </p>
                    <Badge
                      variant="outline"
                      className="mt-0.5 text-[10px] border-brand-orange/40 text-brand-orange"
                    >
                      {it.priority}
                    </Badge>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-muted-foreground">
                  <span>route: {it.sourceType}</span>
                  <span>
                    suggested{" "}
                    <span className="font-mono text-brand-orange">
                      +{it.suggested.toLocaleString()}
                    </span>{" "}
                    {it.unit}
                  </span>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Batches today</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentBatches.length === 0 && (
              <p className="text-sm text-muted-foreground">No batches recorded today.</p>
            )}
            {recentBatches.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0"
              >
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
              {suffix && (
                <span className="text-sm font-normal text-muted-foreground ml-1">{suffix}</span>
              )}
            </p>
          </div>
          <div
            className={
              accent === "warn"
                ? "size-9 rounded-md bg-brand-orange/10 text-brand-orange flex items-center justify-center"
                : "size-9 rounded-md bg-muted text-muted-foreground flex items-center justify-center"
            }
          >
            <Icon className="size-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
