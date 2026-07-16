import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, ClipboardCheck, AlertTriangle, Trash2 } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { CAN_VIEW_ALL_SHOP_COUNTS, hasAny, isShopSupervisorOnly } from "@/lib/permissions";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/shop-counts/")({
  component: ShopCountsPage,
});

interface CountRow {
  id: string;
  shop_id: string;
  count_date: string;
  count_type: "opening" | "closing";
  status: "draft" | "submitted";
  submitted_at: string | null;
  shops: { name: string } | null;
}

interface PendingRow {
  shop_id: string;
  shop_name: string;
  count_date: string;
  opening_id: string;
  closing_id: string | null;
  closing_status: string | null;
}

function ShopCountsPage() {
  const session = useSession();
  const supervisorOnly = isShopSupervisorOnly(session.roles);
  const canViewAll = hasAny(session.roles, CAN_VIEW_ALL_SHOP_COUNTS);
  const canDelete = session.roles.includes("super_admin") || session.roles.includes("management");
  const [rows, setRows] = useState<CountRow[]>([]);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openNew, setOpenNew] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function handleDelete(id: string) {
    if (!confirm("Delete this count? This cannot be undone. If it's an opening count, the matching draft closing will also be removed.")) return;
    setDeleting(id);
    const { error } = await supabase.rpc("delete_shop_stock_count" as any, { _count_id: id });
    setDeleting(null);
    if (error) return toast.error(error.message);
    toast.success("Count deleted");
    load();
  }

  async function load() {
    setLoading(true);
    const [{ data, error }, { data: pend }] = await Promise.all([
      supabase
        .from("shop_stock_counts")
        .select("id, shop_id, count_date, count_type, status, submitted_at, shops(name)")
        .order("count_date", { ascending: false })
        .order("count_type")
        .limit(200),
      supabase.from("v_shop_pending_closings" as any)
        .select("*").order("count_date", { ascending: false }),
    ]);
    if (error) toast.error(error.message);
    setRows((data as unknown as CountRow[]) ?? []);
    setPending((pend as unknown as PendingRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Daily shop counts</h1>
          <p className="text-sm text-muted-foreground">
            {supervisorOnly
              ? "Record opening and closing stock at your shop. Operations uses these to plan the next day's packing."
              : "Opening and closing stock submitted by shop supervisors."}
          </p>
        </div>
        {(supervisorOnly || canViewAll) && (
          <Button onClick={() => setOpenNew(true)} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            <Plus className="size-4 mr-2" /> New count
          </Button>
        )}
      </div>

      {pending.length > 0 && (
        <Card className="border-brand-orange/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-brand-orange">
              <AlertTriangle className="size-4" />
              {pending.length} closing count{pending.length === 1 ? "" : "s"} pending
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pending.slice(0, 8).map((p) => (
              <div key={p.opening_id} className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0">
                <div>
                  <p className="font-medium">{p.shop_name}</p>
                  <p className="text-[11px] text-muted-foreground font-mono">
                    {format(new Date(p.count_date), "EEE d MMM yyyy")}
                  </p>
                </div>
                {p.closing_id ? (
                  <Button asChild size="sm" variant="outline">
                    <Link to="/shop-counts/$countId" params={{ countId: p.closing_id }}>Complete closing</Link>
                  </Button>
                ) : (
                  <Badge variant="outline" className="text-brand-orange border-brand-orange/40">Awaiting</Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="rounded-lg border overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground tracking-wider">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Date</th>
              <th className="text-left px-4 py-2 font-medium">Shop</th>
              <th className="text-left px-4 py-2 font-medium">Type</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                  <ClipboardCheck className="mx-auto size-8 mb-2 opacity-50" />
                  No counts recorded yet.
                </td>
              </tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-mono text-xs">{format(new Date(r.count_date), "d MMM yyyy")}</td>
                <td className="px-4 py-3">{r.shops?.name ?? "—"}</td>
                <td className="px-4 py-3 capitalize">{r.count_type}</td>
                <td className="px-4 py-3">
                  {r.status === "submitted" ? (
                    <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50">Submitted</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">Draft</Badge>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/shop-counts/$countId" params={{ countId: r.id }}>Open</Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openNew && <NewCountDialog onClose={() => setOpenNew(false)} onCreated={load} />}
    </div>
  );
}

function NewCountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const session = useSession();
  const supervisorOnly = isShopSupervisorOnly(session.roles);
  const [shops, setShops] = useState<Array<{ id: string; name: string }>>([]);
  const [shopId, setShopId] = useState<string>(supervisorOnly ? session.shopId ?? "" : "");
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [type, setType] = useState<"opening" | "closing">("opening");
  const [saving, setSaving] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const navigate = Route.useNavigate();

  useEffect(() => {
    if (!supervisorOnly) {
      supabase.from("shops").select("id, name").eq("is_active", true).order("name").then(({ data }) => {
        setShops(data ?? []);
      });
    }
  }, [supervisorOnly]);

  // Warn when opening a new day while previous day's closing missing
  useEffect(() => {
    setWarning(null);
    if (!shopId || type !== "opening") return;
    const prev = new Date(date);
    prev.setDate(prev.getDate() - 1);
    const prevStr = prev.toISOString().slice(0, 10);
    (async () => {
      const { data } = await supabase
        .from("shop_stock_counts")
        .select("id, status, count_type")
        .eq("shop_id", shopId)
        .eq("count_date", prevStr);
      const rows = (data ?? []) as Array<{ status: string; count_type: string }>;
      const hasOpening = rows.some((r) => r.count_type === "opening" && r.status === "submitted");
      const closed = rows.some((r) => r.count_type === "closing" && r.status === "submitted");
      if (hasOpening && !closed) {
        setWarning(`Previous day (${format(prev, "d MMM")}) closing count is not submitted yet. Complete it before opening a new day.`);
      }
    })();
  }, [shopId, date, type]);

  async function create() {
    if (!shopId) return toast.error("Pick a shop");
    setSaving(true);
    const { data: existing } = await supabase
      .from("shop_stock_counts")
      .select("id")
      .eq("shop_id", shopId)
      .eq("count_date", date)
      .eq("count_type", type)
      .maybeSingle();
    let id = existing?.id;
    if (!id) {
      const { data, error } = await supabase
        .from("shop_stock_counts")
        .insert({ shop_id: shopId, count_date: date, count_type: type })
        .select("id")
        .single();
      if (error) { setSaving(false); return toast.error(error.message); }
      id = data.id;

      const { data: assort } = await supabase
        .from("shop_assortments")
        .select("item_id, inventory_items!inner(category)")
        .eq("shop_id", shopId)
        .eq("inventory_items.category", "finished_good");
      if (assort && assort.length > 0) {
        await supabase.from("shop_stock_count_lines").insert(
          assort.map((a) => ({ count_id: id!, item_id: a.item_id, quantity_counted: 0 })),
        );
      }
    }
    setSaving(false);
    onCreated();
    navigate({ to: "/shop-counts/$countId", params: { countId: id! } });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New count</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Shop</Label>
            {supervisorOnly ? (
              <Input value={session.shopId ? "Your shop" : "— unassigned —"} readOnly className="bg-muted/40" />
            ) : (
              <Select value={shopId} onValueChange={setShopId}>
                <SelectTrigger><SelectValue placeholder="Select shop" /></SelectTrigger>
                <SelectContent>{shops.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as "opening" | "closing")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="opening">Opening</SelectItem>
                  <SelectItem value="closing">Closing</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {warning && (
            <div className="rounded-md border border-brand-orange/40 bg-brand-orange/5 p-3 text-xs text-brand-orange flex gap-2">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <span>{warning}</span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={saving} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            {saving ? "Opening…" : "Open count"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
