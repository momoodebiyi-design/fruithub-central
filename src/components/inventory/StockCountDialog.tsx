import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchOnHand, StockReadError } from "@/lib/stock";
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
import { toast } from "sonner";

export function StockCountDialog({
  item,
  onClose,
  onSaved,
}: {
  item: { id: string; name: string; sku: string; unit: string; quantity: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [count, setCount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  // Always re-read on_hand from the ledger at open time — never trust the
  // cached `item.quantity` value coming from the caller.
  const [system, setSystem] = useState<number>(Number(item.quantity ?? 0));
  const [loadingSystem, setLoadingSystem] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchOnHand(item.id).then((v) => {
      if (!cancelled) {
        setSystem(v);
        setLoadingSystem(false);
      }
    });
    return () => { cancelled = true; };
  }, [item.id]);

  const physical = Number(count);
  const delta = count === "" ? 0 : physical - system;

  async function save() {
    if (loadingSystem) return toast.error("Still reading current stock — try again in a moment");
    if (count === "" || Number.isNaN(physical) || physical < 0) {
      return toast.error("Enter a physical count (0 or more)");
    }
    if (delta === 0) return toast.info("No difference to record");
    if (!reason.trim()) return toast.error("Add a reason for the adjustment");

    setSaving(true);
    const { data: userData } = await supabase.auth.getUser();
    // Trigger treats `adjustment` as an additive delta — insert the signed delta.
    const { error } = await supabase.from("inventory_movements").insert({
      item_id: item.id,
      type: "adjustment",
      quantity: delta,
      reason: `Stock count: physical ${physical} vs system ${system} — ${reason.trim()}`,
      performed_by: userData.user?.id,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Stock count recorded");
    onSaved();
    onClose();
  }


  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Stock count / audit</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="bg-muted rounded-md p-3">
            <p className="text-sm font-medium">{item.name}</p>
            <p className="text-xs text-muted-foreground font-mono">{item.sku}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>System count</Label>
              <Input value={loadingSystem ? "…" : `${system.toLocaleString()} ${item.unit}`} readOnly className="font-mono" />
            </div>
            <div>
              <Label>Physical count</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={count}
                onChange={(e) => setCount(e.target.value)}
                placeholder="Actual on shelf"
              />
            </div>
          </div>
          {count !== "" && (
            <div className="text-sm">
              Difference:{" "}
              <span
                className={`font-mono font-semibold ${delta === 0 ? "" : delta > 0 ? "text-brand-green" : "text-brand-orange"}`}
              >
                {delta > 0 ? "+" : ""}
                {delta.toLocaleString()} {item.unit}
              </span>
            </div>
          )}
          <div>
            <Label>Reason</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Breakage, miscount, theft, expiry cleared, etc."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            {saving ? "Recording…" : "Record adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
