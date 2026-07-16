import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface Item { id: string; name: string; sku: string; category: string | null }
interface AssortRow { item_id: string; target_level: number | null }

export function AssortmentDialog({
  shopId,
  shopName,
  onClose,
}: {
  shopId: string;
  shopName: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targets, setTargets] = useState<Map<string, number>>(new Map());
  const [initial, setInitial] = useState<Map<string, number>>(new Map());
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [{ data: allItems }, { data: assort }] = await Promise.all([
        supabase.from("inventory_items").select("id, name, sku, category").eq("is_active", true).eq("category", "finished_good").order("name"),
        supabase.from("shop_assortments").select("item_id, target_level").eq("shop_id", shopId),
      ]);
      setItems((allItems as Item[]) ?? []);
      const rows = ((assort as unknown as AssortRow[]) ?? []);
      const sel = new Set(rows.map((a) => a.item_id));
      const tgt = new Map(rows.map((a) => [a.item_id, Number(a.target_level ?? 0)]));
      setSelected(sel);
      setTargets(tgt);
      setInitial(new Map(tgt));
    })();
  }, [shopId]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setTarget(id: string, v: number) {
    setTargets((prev) => {
      const next = new Map(prev);
      next.set(id, v);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    const toRemove = [...initial.keys()].filter((id) => !selected.has(id));
    const toUpsert = [...selected].map((item_id) => ({
      shop_id: shopId,
      item_id,
      target_level: Number(targets.get(item_id) ?? 0),
    }));
    if (toRemove.length > 0) {
      const { error } = await supabase
        .from("shop_assortments").delete().eq("shop_id", shopId).in("item_id", toRemove);
      if (error) { setSaving(false); return toast.error(error.message); }
    }
    if (toUpsert.length > 0) {
      const { error } = await supabase
        .from("shop_assortments")
        .upsert(toUpsert, { onConflict: "shop_id,item_id" });
      if (error) { setSaving(false); return toast.error(error.message); }
    }
    setSaving(false);
    toast.success("Assortment updated");
    onClose();
  }

  const filtered = items.filter(
    (i) => !q || i.name.toLowerCase().includes(q.toLowerCase()) || i.sku.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Assortment — {shopName}</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Finished goods this shop stocks. Target level drives next-day restock recommendations.
          </p>
        </DialogHeader>
        <Input placeholder="Search items…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex-1 overflow-y-auto border rounded-md divide-y">
          {filtered.map((i) => {
            const isOn = selected.has(i.id);
            return (
              <div key={i.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40">
                <Checkbox checked={isOn} onCheckedChange={() => toggle(i.id)} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{i.name}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{i.sku}</p>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[11px] text-muted-foreground">Target</span>
                  <Input
                    type="number"
                    className="w-20 h-8 font-mono text-right"
                    value={targets.get(i.id) ?? 0}
                    onChange={(e) => setTarget(i.id, Number(e.target.value))}
                    disabled={!isOn}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <span className="text-xs text-muted-foreground mr-auto">{selected.size} selected</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            {saving ? "Saving…" : "Save assortment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
