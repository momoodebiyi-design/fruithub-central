import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

interface LineRow {
  id: string;
  item_id: string;
  quantity_dispatched: number;
  quantity_returned: number;
  inventory_items: { name: string; unit: string } | null;
}

export function ReturnDialog({
  dispatchId,
  reference,
  onClose,
  onSaved,
}: {
  dispatchId: string;
  reference: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [lines, setLines] = useState<LineRow[]>([]);
  const [returnQty, setReturnQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("dispatch_lines")
        .select("id, item_id, quantity_dispatched, quantity_returned, inventory_items(name, unit)")
        .eq("dispatch_id", dispatchId);
      setLines((data as unknown as LineRow[]) ?? []);
    })();
  }, [dispatchId]);

  async function save() {
    const payload = lines
      .map((l) => ({ line_id: l.id, quantity: Number(returnQty[l.id] ?? 0) }))
      .filter((l) => l.quantity > 0);
    if (payload.length === 0) return toast.error("Enter at least one return quantity");
    setSaving(true);
    const { error } = await supabase.rpc("record_shop_return" as any, {
      _dispatch_id: dispatchId,
      _lines: payload,
      _reason: reason.trim() || null,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Return recorded");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Return from shop · {reference}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            {lines.map((l) => {
              const remaining = Number(l.quantity_dispatched) - Number(l.quantity_returned);
              return (
                <div key={l.id} className="flex items-center gap-2 border rounded-md p-2">
                  <div className="flex-1">
                    <div className="text-sm font-medium">{l.inventory_items?.name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      Remaining {remaining} {l.inventory_items?.unit ?? ""}
                    </div>
                  </div>
                  <Input
                    type="number"
                    className="w-24 font-mono"
                    placeholder="0"
                    max={remaining}
                    value={returnQty[l.id] ?? ""}
                    onChange={(e) => setReturnQty({ ...returnQty, [l.id]: e.target.value })}
                    disabled={remaining <= 0}
                  />
                </div>
              );
            })}
          </div>
          <div>
            <Label>Reason / notes</Label>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. unsold stock, damaged in transit" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            {saving ? "Recording…" : "Record return"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
