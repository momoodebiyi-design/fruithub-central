import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface Item { id: string; name: string; sku: string; category: string | null }

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
  const [initial, setInitial] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [{ data: allItems }, { data: assort }] = await Promise.all([
        supabase.from("inventory_items").select("id, name, sku, category").eq("is_active", true).order("name"),
        supabase.from("shop_assortments").select("item_id").eq("shop_id", shopId),
      ]);
      setItems((allItems as Item[]) ?? []);
      const set = new Set((assort ?? []).map((a) => a.item_id));
      setSelected(set);
      setInitial(new Set(set));
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

  async function save() {
    setSaving(true);
    const toAdd = [...selected].filter((id) => !initial.has(id));
    const toRemove = [...initial].filter((id) => !selected.has(id));
    if (toAdd.length > 0) {
      const { error } = await supabase
        .from("shop_assortments")
        .insert(toAdd.map((item_id) => ({ shop_id: shopId, item_id })));
      if (error) { setSaving(false); return toast.error(error.message); }
    }
    if (toRemove.length > 0) {
      const { error } = await supabase
        .from("shop_assortments")
        .delete()
        .eq("shop_id", shopId)
        .in("item_id", toRemove);
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
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Assortment — {shopName}</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Items this shop stocks. Seeds the daily count forms.
          </p>
        </DialogHeader>
        <Input placeholder="Search items…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex-1 overflow-y-auto border rounded-md divide-y">
          {filtered.map((i) => (
            <label key={i.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40">
              <Checkbox checked={selected.has(i.id)} onCheckedChange={() => toggle(i.id)} />
              <span className="flex-1 text-sm">{i.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{i.sku}</span>
            </label>
          ))}
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
