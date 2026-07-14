import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface ShopOpt { id: string; name: string }
interface ItemOpt { id: string; name: string; sku: string; unit: string; quantity: number }
interface Line { item_id: string; quantity: string }

export function DispatchDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [shops, setShops] = useState<ShopOpt[]>([]);
  const [items, setItems] = useState<ItemOpt[]>([]);
  const [shopId, setShopId] = useState<string>("");
  const [reference, setReference] = useState(`DSP-${Date.now().toString(36).toUpperCase()}`);
  const [vehicle, setVehicle] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([{ item_id: "", quantity: "" }]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [{ data: s }, { data: i }] = await Promise.all([
        supabase.from("shops").select("id, name").eq("is_active", true).order("name"),
        supabase.from("inventory_items").select("id, name, sku, unit, quantity").eq("is_active", true).order("name"),
      ]);
      setShops((s as ShopOpt[]) ?? []);
      setItems((i as ItemOpt[]) ?? []);
    })();
  }, []);

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function save() {
    if (!shopId) return toast.error("Choose a shop");
    const valid = lines.filter((l) => l.item_id && Number(l.quantity) > 0);
    if (valid.length === 0) return toast.error("Add at least one line");
    setSaving(true);
    const { error } = await supabase.rpc("create_dispatch", {
      _shop_id: shopId,
      _reference: reference.trim(),
      _vehicle: vehicle.trim() || null,
      _notes: notes.trim() || null,
      _lines: valid.map((l) => ({ item_id: l.item_id, quantity: Number(l.quantity) })),
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Dispatch recorded");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New dispatch</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Shop</Label>
              <Select value={shopId} onValueChange={setShopId}>
                <SelectTrigger><SelectValue placeholder="Select shop" /></SelectTrigger>
                <SelectContent>
                  {shops.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Reference</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Vehicle</Label>
              <Input value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <Label>Notes</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Items</Label>
              <Button size="sm" variant="ghost" onClick={() => setLines([...lines, { item_id: "", quantity: "" }])}>
                <Plus className="size-3 mr-1" /> Add line
              </Button>
            </div>
            <div className="space-y-2">
              {lines.map((line, idx) => {
                const item = items.find((i) => i.id === line.item_id);
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <Select value={line.item_id} onValueChange={(v) => updateLine(idx, { item_id: v })}>
                      <SelectTrigger className="flex-1"><SelectValue placeholder="Item" /></SelectTrigger>
                      <SelectContent>
                        {items.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.name} · {i.quantity} {i.unit} on hand
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      className="w-28 font-mono"
                      placeholder="Qty"
                      value={line.quantity}
                      onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                    />
                    <span className="w-10 text-xs text-muted-foreground">{item?.unit ?? ""}</span>
                    <Button size="icon" variant="ghost" onClick={() => setLines(lines.filter((_, i) => i !== idx))}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            {saving ? "Recording…" : "Record dispatch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
