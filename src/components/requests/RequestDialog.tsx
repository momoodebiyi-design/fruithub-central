/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useSession } from "@/hooks/useSession";
import { isShopSupervisorOnly } from "@/lib/permissions";

interface ItemOpt {
  id: string;
  name: string;
  unit: string;
  quantity: number;
}
interface ShopOpt {
  id: string;
  name: string;
}
interface LocationOpt {
  id: string;
  name: string;
  shop_id: string | null;
  is_default: boolean;
}

export function RequestDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const supervisorOnly = isShopSupervisorOnly(session.roles);
  const [items, setItems] = useState<ItemOpt[]>([]);
  const [shops, setShops] = useState<ShopOpt[]>([]);
  const [itemId, setItemId] = useState<string>("");
  const [quantity, setQuantity] = useState("");
  const [purpose, setPurpose] = useState("");
  const [shopId, setShopId] = useState<string>(supervisorOnly ? (session.shopId ?? "") : "");
  const [supervisorShopName, setSupervisorShopName] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [sourceLocationId, setSourceLocationId] = useState("");
  const [destinationLocationId, setDestinationLocationId] = useState("");

  useEffect(() => {
    (async () => {
      const [{ data: inventory }, { data: s }, { data: locs }] = await Promise.all([
        supabase
          .from("inventory_items")
          .select("id, name, unit, category")
          .eq("status", "active")
          .eq("category", "finished_good")
          .order("name"),
        supabase.from("shops").select("id, name").eq("is_active", true).order("name"),
        (supabase as any)
          .from("locations")
          .select("id, name, shop_id, is_default")
          .eq("status", "active")
          .order("name"),
      ]);
      const locations = (locs as LocationOpt[]) ?? [];
      const central =
        locations.find((location) => location.is_default) ??
        locations.find((location) => location.name === "Main Store");
      const shopOne =
        ((s as ShopOpt[]) ?? []).find((shop) => shop.name.toLowerCase() === "shop 1") ??
        (s as ShopOpt[] | null)?.[0];
      const destination =
        locations.find((location) => location.shop_id === shopOne?.id) ??
        locations.find((location) => location.name.toLowerCase() === "shop 1");
      setSourceLocationId(central?.id ?? "");
      setDestinationLocationId(destination?.id ?? "");
      if (!supervisorOnly && shopOne) setShopId(shopOne.id);
      const ids = ((inventory as any[]) ?? []).map((row) => row.id);
      const { data: balances } =
        ids.length && central
          ? await (supabase as any)
              .from("v_item_location_stock")
              .select("item_id, on_hand")
              .eq("location_id", central.id)
              .in("item_id", ids)
          : { data: [] };
      const balanceMap = new Map(
        ((balances as any[]) ?? []).map((row) => [row.item_id, Number(row.on_hand ?? 0)]),
      );
      setItems(
        ((inventory as any[]) ?? []).map((row) => ({
          id: row.id,
          name: row.name,
          unit: row.unit,
          quantity: balanceMap.get(row.id) ?? 0,
        })),
      );
      setShops(((s as ShopOpt[]) ?? []).filter((shop) => shop.name.toLowerCase() === "shop 1"));
      if (supervisorOnly && session.shopId) {
        const shop = ((s as ShopOpt[]) ?? []).find((x) => x.id === session.shopId);
        setSupervisorShopName(shop?.name ?? "");
        setShopId(session.shopId);
      }
    })();
  }, [supervisorOnly, session.shopId]);

  async function save() {
    if (
      !itemId ||
      !purpose.trim() ||
      Number(quantity) <= 0 ||
      !sourceLocationId ||
      !destinationLocationId ||
      !shopId
    ) {
      return toast.error("Item, quantity and purpose are required");
    }
    if (supervisorOnly && !session.shopId) {
      return toast.error("Your account isn't assigned to a shop. Ask an admin to set it.");
    }
    if (!session.user) return toast.error("Not signed in");
    setSaving(true);
    const { error } = await (supabase as any).from("stock_requests").insert({
      requested_by: session.user.id,
      item_id: itemId,
      quantity: Number(quantity),
      purpose: purpose.trim(),
      destination_shop_id: shopId || null,
      source_location_id: sourceLocationId,
      destination_location_id: destinationLocationId,
      request_kind: "midday",
      replenishment_status: "requested",
      client_reference_id: crypto.randomUUID(),
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Urgent replenishment request submitted");
    onSaved();
    onClose();
  }

  const item = items.find((i) => i.id === itemId);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Urgent Shop 1 replenishment</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Item</Label>
            <Select value={itemId} onValueChange={setItemId}>
              <SelectTrigger>
                <SelectValue placeholder="Select item" />
              </SelectTrigger>
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
              <Input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="flex items-end text-xs text-muted-foreground">{item?.unit ?? ""}</div>
          </div>
          <div>
            <Label>Destination shop</Label>
            {supervisorOnly ? (
              <Input
                value={supervisorShopName || "— unassigned —"}
                readOnly
                className="bg-muted/40"
              />
            ) : (
              <Select value={shopId} onValueChange={setShopId}>
                <SelectTrigger>
                  <SelectValue placeholder="Shop 1" />
                </SelectTrigger>
                <SelectContent>
                  {shops.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div>
            <Label>Reason</Label>
            <Textarea
              rows={3}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Why is this needed during the day?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving}
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            {saving ? "Submitting…" : "Submit urgent request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
