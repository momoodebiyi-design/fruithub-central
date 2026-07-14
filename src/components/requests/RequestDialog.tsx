import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { useSession } from "@/hooks/useSession";

interface ItemOpt { id: string; name: string; unit: string; quantity: number }
interface ShopOpt { id: string; name: string }

export function RequestDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const session = useSession();
  const [items, setItems] = useState<ItemOpt[]>([]);
  const [shops, setShops] = useState<ShopOpt[]>([]);
  const [itemId, setItemId] = useState<string>("");
  const [quantity, setQuantity] = useState("");
  const [purpose, setPurpose] = useState("");
  const [shopId, setShopId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [{ data: i }, { data: s }] = await Promise.all([
        supabase.from("inventory_items").select("id, name, unit, quantity").eq("is_active", true).order("name"),
        supabase.from("shops").select("id, name").eq("is_active", true).order("name"),
      ]);
      setItems((i as ItemOpt[]) ?? []);
      setShops((s as ShopOpt[]) ?? []);
    })();
  }, []);

  async function save() {
    if (!itemId || !purpose.trim() || Number(quantity) <= 0) {
      return toast.error("Item, quantity and purpose are required");
    }
    if (!session.user) return toast.error("Not signed in");
    setSaving(true);
    const { error } = await supabase.from("stock_requests").insert({
      requested_by: session.user.id,
      item_id: itemId,
      quantity: Number(quantity),
      purpose: purpose.trim(),
      destination_shop_id: shopId || null,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Request submitted");
    onSaved();
    onClose();
  }

  const item = items.find((i) => i.id === itemId);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Request stock</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Item</Label>
            <Select value={itemId} onValueChange={setItemId}>
              <SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger>
              <SelectContent>
                {items.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.name} · {i.quantity} {i.unit} on hand
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Quantity</Label>
              <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="font-mono" />
            </div>
            <div className="flex items-end text-xs text-muted-foreground">{item?.unit ?? ""}</div>
          </div>
          <div>
            <Label>Destination shop (optional)</Label>
            <Select value={shopId} onValueChange={setShopId}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                {shops.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Purpose</Label>
            <Textarea rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Why is this stock needed?" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            {saving ? "Submitting…" : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
