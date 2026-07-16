import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, ClipboardCheck } from "lucide-react";
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

function ShopCountsPage() {
  const session = useSession();
  const supervisorOnly = isShopSupervisorOnly(session.roles);
  const canViewAll = hasAny(session.roles, CAN_VIEW_ALL_SHOP_COUNTS);
  const [rows, setRows] = useState<CountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openNew, setOpenNew] = useState(false);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("shop_stock_counts")
      .select("id, shop_id, count_date, count_type, status, submitted_at, shops(name)")
      .order("count_date", { ascending: false })
      .order("count_type")
      .limit(200);
    if (error) toast.error(error.message);
    setRows((data as unknown as CountRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

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
  const navigate = Route.useNavigate();

  useEffect(() => {
    if (!supervisorOnly) {
      supabase.from("shops").select("id, name").eq("is_active", true).order("name").then(({ data }) => {
        setShops(data ?? []);
      });
    }
  }, [supervisorOnly]);

  async function create() {
    if (!shopId) return toast.error("Pick a shop");
    setSaving(true);
    // Try to find existing draft first
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
      if (error) {
        setSaving(false);
        return toast.error(error.message);
      }
      id = data.id;

      // Seed lines from shop assortment
      const { data: assort } = await supabase
        .from("shop_assortments")
        .select("item_id")
        .eq("shop_id", shopId);
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
