import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Plus, Trash2, Send, TrendingDown, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/shop-counts/$countId")({
  component: CountDetailPage,
});

interface CountHeader {
  id: string;
  shop_id: string;
  count_date: string;
  count_type: "opening" | "closing";
  status: "draft" | "submitted";
  notes: string | null;
  submitted_at: string | null;
  shops: { name: string } | null;
}
interface CountLine {
  id: string;
  item_id: string;
  quantity_counted: number;
  inventory_items: { name: string; unit: string; sku: string } | null;
}
interface BalanceRow {
  shop_id: string;
  count_date: string;
  item_id: string;
  opening_qty: number | null;
  received: number;
  returned: number;
  actual_closing: number | null;
  expected_closing: number | null;
  variance: number | null;
  target_level: number | null;
  restock_recommendation: number | null;
}
interface ItemOpt { id: string; name: string; unit: string }

function CountDetailPage() {
  const { countId } = Route.useParams();
  const [header, setHeader] = useState<CountHeader | null>(null);
  const [lines, setLines] = useState<CountLine[]>([]);
  const [items, setItems] = useState<ItemOpt[]>([]);
  const [balance, setBalance] = useState<BalanceRow[]>([]);
  const [notes, setNotes] = useState("");
  const [addItemId, setAddItemId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    const [{ data: h }, { data: l }, { data: i }] = await Promise.all([
      supabase.from("shop_stock_counts").select("*, shops(name)").eq("id", countId).maybeSingle(),
      supabase.from("shop_stock_count_lines")
        .select("id, item_id, quantity_counted, inventory_items(name, unit, sku)")
        .eq("count_id", countId),
      supabase.from("inventory_items").select("id, name, unit").eq("is_active", true).eq("category", "finished_good").order("name"),
    ]);
    const headerData = (h as unknown as CountHeader) ?? null;
    setHeader(headerData);
    setLines((l as unknown as CountLine[]) ?? []);
    setItems((i as ItemOpt[]) ?? []);
    setNotes((h as CountHeader | null)?.notes ?? "");

    if (headerData) {
      const { data: b } = await supabase
        .from("v_shop_daily_balance" as any)
        .select("*")
        .eq("shop_id", headerData.shop_id)
        .eq("count_date", headerData.count_date);
      setBalance((b as unknown as BalanceRow[]) ?? []);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, [countId]);

  const readOnly = header?.status === "submitted";
  const isClosing = header?.count_type === "closing";

  async function updateQty(lineId: string, value: number) {
    setLines((ls) => ls.map((l) => (l.id === lineId ? { ...l, quantity_counted: value } : l)));
    const { error } = await supabase
      .from("shop_stock_count_lines")
      .update({ quantity_counted: value })
      .eq("id", lineId);
    if (error) toast.error(error.message);
  }

  async function addLine() {
    if (!addItemId) return;
    if (lines.some((l) => l.item_id === addItemId)) {
      toast.error("Item already on this count");
      return;
    }
    const { error } = await supabase
      .from("shop_stock_count_lines")
      .insert({ count_id: countId, item_id: addItemId, quantity_counted: 0 });
    if (error) return toast.error(error.message);
    setAddItemId("");
    load();
  }

  async function removeLine(lineId: string) {
    const { error } = await supabase.from("shop_stock_count_lines").delete().eq("id", lineId);
    if (error) return toast.error(error.message);
    setLines((ls) => ls.filter((l) => l.id !== lineId));
  }

  async function saveNotes() {
    await supabase.from("shop_stock_counts").update({ notes }).eq("id", countId);
  }

  async function submit() {
    if (lines.length === 0) return toast.error("Add at least one item before submitting");
    setSaving(true);
    await saveNotes();
    const { error } = await supabase.rpc("submit_shop_stock_count" as any, { _count_id: countId });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(
      isClosing
        ? "Closing count submitted — variance & restock recommendations now available"
        : "Opening count submitted — closing count is now required at end of day",
    );
    load();
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!header) return <p className="text-sm text-muted-foreground">Count not found.</p>;

  const missingItems = items.filter((i) => !lines.some((l) => l.item_id === i.id));
  const balanceByItem = new Map(balance.map((b) => [b.item_id, b]));

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/shop-counts">
            <ArrowLeft className="size-4 mr-1" /> All counts
          </Link>
        </Button>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight capitalize">
            {header.count_type} count — {header.shops?.name}
          </h1>
          <p className="text-sm text-muted-foreground font-mono">
            {format(new Date(header.count_date), "EEEE, d MMMM yyyy")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {readOnly ? (
            <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50">Submitted</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">Draft</Badge>
          )}
          {!readOnly && (
            <Button onClick={submit} disabled={saving} className="bg-brand-orange text-white hover:bg-brand-orange/90">
              <Send className="size-4 mr-2" />
              {saving ? "Submitting…" : "Submit count"}
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-lg border overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground tracking-wider">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Item</th>
              {isClosing && <th className="text-right px-3 py-2 font-medium">Opening</th>}
              {isClosing && <th className="text-right px-3 py-2 font-medium">Received</th>}
              {isClosing && <th className="text-right px-3 py-2 font-medium">Returned</th>}
              {isClosing && <th className="text-right px-3 py-2 font-medium">Expected</th>}
              <th className="text-right px-4 py-2 font-medium">{isClosing ? "Actual closing" : "Counted"}</th>
              {isClosing && <th className="text-right px-3 py-2 font-medium">Variance</th>}
              <th className="w-16" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.length === 0 ? (
              <tr><td colSpan={isClosing ? 8 : 3} className="px-4 py-8 text-center text-muted-foreground">No items yet. Add items below.</td></tr>
            ) : lines.map((l) => {
              const b = balanceByItem.get(l.item_id);
              const variance = b && b.expected_closing !== null
                ? Number(l.quantity_counted) - Number(b.expected_closing)
                : null;
              return (
                <tr key={l.id}>
                  <td className="px-4 py-2">
                    <p>{l.inventory_items?.name ?? "—"}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">{l.inventory_items?.sku ?? "—"}</p>
                  </td>
                  {isClosing && <td className="px-3 py-2 text-right font-mono text-xs">{b?.opening_qty ?? "—"}</td>}
                  {isClosing && <td className="px-3 py-2 text-right font-mono text-xs">{b ? Number(b.received).toFixed(0) : "0"}</td>}
                  {isClosing && <td className="px-3 py-2 text-right font-mono text-xs">{b ? Number(b.returned).toFixed(0) : "0"}</td>}
                  {isClosing && <td className="px-3 py-2 text-right font-mono text-xs">{b?.expected_closing ?? "—"}</td>}
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2 justify-end">
                      <Input
                        type="number"
                        className="w-24 font-mono text-right"
                        value={l.quantity_counted}
                        onChange={(e) => updateQty(l.id, Number(e.target.value))}
                        disabled={readOnly}
                      />
                      <span className="text-xs text-muted-foreground w-10">{l.inventory_items?.unit}</span>
                    </div>
                  </td>
                  {isClosing && (
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {variance === null ? "—" : (
                        <span className={variance < 0 ? "text-brand-orange" : variance > 0 ? "text-emerald-600" : "text-muted-foreground"}>
                          {variance > 0 ? "+" : ""}{variance.toFixed(0)}
                        </span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-2">
                    {!readOnly && (
                      <Button variant="ghost" size="icon" onClick={() => removeLine(l.id)}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isClosing && readOnly && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="size-4 text-brand-orange" />
              Next-day restock recommendation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground tracking-wider">
                <tr>
                  <th className="text-left py-2 font-medium">Item</th>
                  <th className="text-right py-2 font-medium">Target</th>
                  <th className="text-right py-2 font-medium">On hand</th>
                  <th className="text-right py-2 font-medium">Restock</th>
                  <th className="w-40" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {balance.filter((b) => Number(b.restock_recommendation ?? 0) > 0).length === 0 ? (
                  <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">All items at target level.</td></tr>
                ) : balance
                  .filter((b) => Number(b.restock_recommendation ?? 0) > 0)
                  .map((b) => {
                    const line = lines.find((l) => l.item_id === b.item_id);
                    const item = items.find((i) => i.id === b.item_id) ?? line?.inventory_items;
                    return (
                      <tr key={b.item_id}>
                        <td className="py-2">{(item as any)?.name ?? b.item_id}</td>
                        <td className="py-2 text-right font-mono text-xs">{b.target_level ?? 0}</td>
                        <td className="py-2 text-right font-mono text-xs">{b.actual_closing ?? 0}</td>
                        <td className="py-2 text-right font-mono text-sm text-brand-orange">
                          +{Number(b.restock_recommendation).toFixed(0)}
                        </td>
                        <td className="py-2 text-right">
                          <RequestRestockButton
                            itemId={b.item_id}
                            shopId={header!.shop_id}
                            shopName={header!.shops?.name ?? "shop"}
                            itemName={(item as any)?.name ?? "item"}
                            quantity={Number(b.restock_recommendation)}
                          />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            {balance.some((b) => Number(b.variance ?? 0) < 0) && (
              <p className="mt-3 text-xs text-brand-orange flex items-center gap-1">
                <TrendingDown className="size-3" />
                Negative variance detected — inventory manager should review shrinkage before restocking.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {!readOnly && (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label>Add item</Label>
            <Select value={addItemId} onValueChange={setAddItemId}>
              <SelectTrigger><SelectValue placeholder="Pick an item" /></SelectTrigger>
              <SelectContent>
                {missingItems.map((i) => <SelectItem key={i.id} value={i.id}>{i.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={addLine} disabled={!addItemId}>
            <Plus className="size-4 mr-1" /> Add
          </Button>
        </div>
      )}

      <div>
        <Label>Notes</Label>
        <Textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
          disabled={readOnly}
          placeholder="Anything operations should know (spoilage, low items, incidents…)"
        />
      </div>
    </div>
  );
}
