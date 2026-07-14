import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowUpDown, ClipboardList, Pencil } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { CAN_WRITE_INVENTORY, hasAny } from "@/lib/permissions";
import { MovementDialog } from "@/components/inventory/MovementDialog";
import { StockCountDialog } from "@/components/inventory/StockCountDialog";
import { ItemDialog } from "@/components/inventory/ItemDialog";
import {
  computeUsageStats,
  daysUntilDepletion,
  recommendReorder,
  monthlyBuckets,
  type MovementLite,
} from "@/lib/inventory-analytics";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/_authenticated/inventory/$itemId")({
  component: ItemDetail,
});

interface Item {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  quantity: number;
  min_level: number | null;
  reorder_level: number | null;
  location: string | null;
  notes: string | null;
  is_active: boolean;
  supplier_id: string | null;
  updated_at: string;
}

interface Movement extends MovementLite {
  id: string;
  reason: string | null;
  performed_by: string | null;
  performer_name?: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  stock_in: "Received",
  stock_out: "Stock out",
  transfer: "Transferred",
  adjustment: "Adjustment",
  damaged: "Damaged",
  expired: "Expired",
  wastage: "Wasted",
  production_consume: "Used in production",
  production_output: "Produced",
};

const POSITIVE_TYPES = new Set(["stock_in", "adjustment", "production_output"]);

function ItemDetail() {
  const { itemId } = useParams({ from: "/_authenticated/inventory/$itemId" });
  const session = useSession();
  const canEdit = hasAny(session.roles, CAN_WRITE_INVENTORY);

  const [item, setItem] = useState<Item | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [supplier, setSupplier] = useState<{ name: string } | null>(null);
  const [showMove, setShowMove] = useState(false);
  const [showCount, setShowCount] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  async function load() {
    const { data: it } = await supabase
      .from("inventory_items")
      .select("*")
      .eq("id", itemId)
      .maybeSingle();
    if (!it) return;
    setItem(it as Item);

    if (it.supplier_id) {
      const { data: s } = await supabase.from("suppliers").select("name").eq("id", it.supplier_id).maybeSingle();
      setSupplier(s as { name: string } | null);
    } else {
      setSupplier(null);
    }

    const { data: ms } = await supabase
      .from("inventory_movements")
      .select("id, type, quantity, reason, performed_by, created_at")
      .eq("item_id", itemId)
      .order("created_at", { ascending: false })
      .limit(200);

    const list = (ms ?? []) as Movement[];
    const userIds = Array.from(new Set(list.map((m) => m.performed_by).filter(Boolean))) as string[];
    if (userIds.length) {
      const { data: profs } = await supabase.from("profiles").select("id, full_name").in("id", userIds);
      const map = new Map((profs ?? []).map((p: any) => [p.id, p.full_name]));
      list.forEach((m) => (m.performer_name = m.performed_by ? map.get(m.performed_by) ?? null : null));
    }
    setMovements(list);
  }

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`item-${itemId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "inventory_movements", filter: `item_id=eq.${itemId}` }, load)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "inventory_items", filter: `id=eq.${itemId}` }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  if (!item) {
    return (
      <div className="text-sm text-muted-foreground">Loading item…</div>
    );
  }

  const stats = computeUsageStats(movements);
  const days = daysUntilDepletion(Number(item.quantity), stats.avgDaily);
  const reorderQty = recommendReorder(stats.avgDaily, Number(item.quantity), item.reorder_level);
  const buckets = monthlyBuckets(movements);
  const low = item.reorder_level !== null && Number(item.quantity) <= Number(item.reorder_level);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/inventory"><ArrowLeft className="size-4 mr-1" /> Inventory</Link>
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <p className="text-xs font-mono text-muted-foreground">{item.sku}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{item.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {item.category.replace("_", " ")} · {item.location ?? "no location"}
            {supplier && <> · supplier {supplier.name}</>}
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowEdit(true)}>
              <Pencil className="size-3.5 mr-1" /> Edit
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowCount(true)}>
              <ClipboardList className="size-3.5 mr-1" /> Count stock
            </Button>
            <Button
              size="sm"
              onClick={() => setShowMove(true)}
              className="bg-brand-orange text-white hover:bg-brand-orange/90"
            >
              <ArrowUpDown className="size-3.5 mr-1" /> Record movement
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="On hand" value={`${Number(item.quantity).toLocaleString()} ${item.unit}`} accent={low ? "warn" : undefined} />
        <StatCard label="Min / reorder" value={`${item.min_level ?? "—"} / ${item.reorder_level ?? "—"}`} />
        <StatCard
          label="Avg daily usage"
          value={stats.avgDaily > 0 ? `${stats.avgDaily.toFixed(1)} ${item.unit}` : "—"}
          hint="last 30 days"
        />
        <StatCard
          label="Est. days left"
          value={days === null ? "—" : `${days} d`}
          accent={days !== null && days <= 7 ? "warn" : undefined}
        />
      </div>

      {low && (
        <div className="bg-brand-orange/10 border border-brand-orange/30 rounded-md p-4 text-sm">
          <p className="font-medium text-brand-orange">Reorder recommended</p>
          <p className="text-muted-foreground mt-1">
            At the current usage rate, this item will run out in{" "}
            <span className="font-mono">{days ?? "—"}</span> days.
            {reorderQty > 0 && (
              <> Order approximately <span className="font-mono font-semibold">{reorderQty.toLocaleString()} {item.unit}</span> to cover the next 30 days.</>
            )}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Consumption (last 6 months)</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={buckets}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="label" fontSize={11} />
                <YAxis fontSize={11} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="used" fill="#f06324" name="Used" />
                <Bar dataKey="received" fill="#1d552d" name="Received" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-2">
            <Row k="Status" v={item.is_active ? "Active" : "Inactive"} />
            <Row k="Unit" v={item.unit} />
            <Row k="Location" v={item.location ?? "—"} />
            <Row k="Supplier" v={supplier?.name ?? "—"} />
            <Row k="Updated" v={new Date(item.updated_at).toLocaleString()} />
            {item.notes && <Row k="Notes" v={item.notes} />}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Movement history</CardTitle>
        </CardHeader>
        <CardContent>
          {movements.length === 0 ? (
            <p className="text-sm text-muted-foreground">No movements recorded yet.</p>
          ) : (
            <ol className="relative border-l pl-6 space-y-4">
              {movements.map((m) => {
                const q = Math.abs(Number(m.quantity));
                const pos = POSITIVE_TYPES.has(m.type) || (m.type === "adjustment" && Number(m.quantity) > 0);
                return (
                  <li key={m.id} className="relative">
                    <span
                      className={`absolute -left-[29px] top-1 size-2.5 rounded-full ring-2 ring-background ${pos ? "bg-brand-green" : "bg-brand-orange"}`}
                    />
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <p className="text-sm font-medium">{TYPE_LABELS[m.type] ?? m.type}</p>
                      <p className={`font-mono text-sm ${pos ? "text-brand-green" : "text-brand-orange"}`}>
                        {pos ? "+" : "−"}
                        {q.toLocaleString()} {item.unit}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(m.created_at).toLocaleString()}
                        {m.performer_name && <> · by {m.performer_name}</>}
                      </p>
                    </div>
                    {m.reason && <p className="text-xs text-muted-foreground mt-0.5">{m.reason}</p>}
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      {showMove && (
        <MovementDialog
          item={item as any}
          onClose={() => setShowMove(false)}
          onSaved={load}
        />
      )}
      {showCount && (
        <StockCountDialog
          item={item as any}
          onClose={() => setShowCount(false)}
          onSaved={load}
        />
      )}
      {showEdit && (
        <ItemDialog
          item={item as any}
          onClose={() => setShowEdit(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: "warn" }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={`mt-1 text-2xl font-semibold font-mono tabular-nums ${accent === "warn" ? "text-brand-orange" : ""}`}>{value}</p>
        {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}
