import { useEffect, useState } from "react";
import { fetchOnHandAtLocation, fetchStockLocations, StockLocation, StockReadError } from "@/lib/stock";
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

// Transfer is intentionally excluded — dispatches/transfers must go through
// the dedicated balanced source→destination workflow, never as a raw movement.
type MovementType = "stock_in" | "stock_out" | "adjustment" | "damaged" | "expired" | "wastage";

const TYPES: { v: MovementType; label: string; hint: string }[] = [
  { v: "stock_in", label: "Receive stock (+)", hint: "Goods received from supplier or return" },
  { v: "stock_out", label: "Use / Stock out (−)", hint: "General consumption not tied to production" },
  { v: "damaged", label: "Damaged (−)", hint: "Breakage, spoilage, unusable" },
  { v: "expired", label: "Expired (−)", hint: "Past expiry, discarded" },
  { v: "wastage", label: "Wasted (−)", hint: "Production spillage, loss" },
  { v: "adjustment", label: "Adjustment (+/−)", hint: "Manual correction — enter signed quantity" },
];

export function MovementDialog({
  item,
  onClose,
  onSaved,
}: {
  item: { id: string; name: string; sku: string; unit: string; quantity: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<MovementType>("stock_in");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [locationId, setLocationId] = useState<string>("");
  const [onHand, setOnHand] = useState<number | null>(null);
  const [onHandError, setOnHandError] = useState<string | null>(null);
  const [loadingOnHand, setLoadingOnHand] = useState(false);

  useEffect(() => {
    fetchStockLocations()
      .then((locs) => {
        setLocations(locs);
        const def = locs.find((l) => l.is_default) ?? locs[0];
        if (def) setLocationId(def.id);
      })
      .catch((e) => toast.error(e instanceof StockReadError ? e.message : "Unable to load locations"));
  }, []);

  useEffect(() => {
    if (!locationId) return;
    let cancelled = false;
    setLoadingOnHand(true);
    setOnHandError(null);
    fetchOnHandAtLocation(item.id, locationId)
      .then((v) => { if (!cancelled) { setOnHand(v); setLoadingOnHand(false); } })
      .catch((e) => {
        if (!cancelled) {
          setOnHand(null); setLoadingOnHand(false);
          setOnHandError(e instanceof StockReadError ? e.message : "On-hand unavailable");
        }
      });
    return () => { cancelled = true; };
  }, [item.id, locationId]);

  async function save() {
    if (!locationId) return toast.error("Select a stock location");
    const n = Number(qty);
    if (!n || (type !== "adjustment" && n <= 0)) return toast.error("Enter a quantity");
    setSaving(true);
    const { error } = await (supabase as any).rpc("record_manual_movement", {
      _item_id: item.id,
      _location_id: locationId,
      _type: type,
      _quantity: n,
      _reason: reason || null,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Movement recorded");
    onSaved();
    onClose();
  }

  const active = TYPES.find((t) => t.v === type);
  const locLabel = onHandError !== null || onHand === null
    ? "On-hand unavailable"
    : `${onHand.toLocaleString()} ${item.unit} at location`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Record movement</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="bg-muted rounded-md p-3">
            <p className="text-sm font-medium">{item.name}</p>
            <p className="text-xs text-muted-foreground font-mono">
              {item.sku} · {loadingOnHand ? "…" : locLabel}
            </p>
          </div>
          <div>
            <Label>Location</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger><SelectValue placeholder="Choose location…" /></SelectTrigger>
              <SelectContent>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}{l.is_default ? " (default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground mt-1">
              Balances and validation are scoped to this location. Transfers between locations use the Dispatch workflow.
            </p>
          </div>
          <div>
            <Label>Movement type</Label>
            <Select value={type} onValueChange={(v) => setType(v as MovementType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{TYPES.map((t) => <SelectItem key={t.v} value={t.v}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
            {active && <p className="text-[11px] text-muted-foreground mt-1">{active.hint}</p>}
          </div>
          <div>
            <Label>Quantity ({item.unit}){type === "adjustment" && " — use negative to reduce"}</Label>
            <Input type="number" step="0.01" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div>
            <Label>Reason / notes</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={save}
            disabled={saving || !locationId}
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            {saving ? "Recording…" : "Record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
