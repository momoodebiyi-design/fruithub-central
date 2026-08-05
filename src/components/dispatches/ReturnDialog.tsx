/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { toast } from "sonner";
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

interface LineRow {
  id: string;
  item_id: string;
  quantity_dispatched: number;
  quantity_returned: number;
  inventory_items: { name: string; unit: string } | null;
}
type Values = Record<string, { returned: string; accepted: string }>;

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
  const [values, setValues] = useState<Values>({});
  const [reason, setReason] = useState("");
  const [conditionNotes, setConditionNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("dispatch_lines")
        .select("id, item_id, quantity_dispatched, quantity_returned, inventory_items(name, unit)")
        .eq("dispatch_id", dispatchId);
      if (error) return toast.error(error.message);
      setLines((data as unknown as LineRow[]) ?? []);
    })();
  }, [dispatchId]);

  function setValue(id: string, patch: Partial<Values[string]>) {
    setValues((current) => ({
      ...current,
      [id]: {
        returned: current[id]?.returned ?? "",
        accepted: current[id]?.accepted ?? "",
        ...patch,
      },
    }));
  }

  async function save() {
    if (!reason.trim()) return toast.error("Enter a return reason");
    const payload = lines
      .map((line) => {
        const returned = Number(values[line.id]?.returned || 0);
        const accepted = Number(values[line.id]?.accepted || 0);
        return {
          line_id: line.id,
          quantity_returned: returned,
          quantity_accepted: accepted,
          quantity_rejected: returned - accepted,
        };
      })
      .filter((line) => line.quantity_returned > 0);
    if (!payload.length) return toast.error("Enter at least one returned quantity");
    if (payload.some((line) => line.quantity_accepted < 0 || line.quantity_rejected < 0))
      return toast.error("Accepted quantity cannot exceed returned quantity");
    setSaving(true);
    const { error } = await (supabase as any).rpc("record_factory_return", {
      _dispatch_id: dispatchId,
      _client_reference_id: crypto.randomUUID(),
      _lines: payload,
      _reason: reason.trim(),
      _condition_notes: conditionNotes.trim() || null,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Factory return recorded — only accepted units were added to Central stock");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Return to factory · {reference}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            Record what physically came back and what Inventory accepted. Rejected or damaged units
            do not increase Central stock.
          </div>
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_120px_120px_100px] gap-2 px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              <div>Product</div>
              <div>Returned</div>
              <div>Accepted</div>
              <div>Rejected</div>
            </div>
            {lines.map((line) => {
              const remaining = Number(line.quantity_dispatched) - Number(line.quantity_returned);
              const returned = Number(values[line.id]?.returned || 0);
              const accepted = Number(values[line.id]?.accepted || 0);
              return (
                <div
                  key={line.id}
                  className="grid grid-cols-[1fr_120px_120px_100px] gap-2 items-center border rounded-md p-2"
                >
                  <div>
                    <p className="text-sm font-medium">{line.inventory_items?.name ?? "—"}</p>
                    <p className="text-xs text-muted-foreground font-mono">
                      Up to {remaining} {line.inventory_items?.unit ?? ""}
                    </p>
                  </div>
                  <Input
                    type="number"
                    min="0"
                    max={remaining}
                    step="0.001"
                    value={values[line.id]?.returned ?? ""}
                    onChange={(e) =>
                      setValue(line.id, { returned: e.target.value, accepted: e.target.value })
                    }
                    disabled={remaining <= 0}
                    className="font-mono text-right"
                  />
                  <Input
                    type="number"
                    min="0"
                    max={returned}
                    step="0.001"
                    value={values[line.id]?.accepted ?? ""}
                    onChange={(e) => setValue(line.id, { accepted: e.target.value })}
                    disabled={returned <= 0}
                    className="font-mono text-right"
                  />
                  <div className="text-right font-mono text-sm pr-2">
                    {Math.max(0, returned - accepted)}
                  </div>
                </div>
              );
            })}
          </div>
          <div>
            <Label>Return reason</Label>
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Required, e.g. unsold stock or packaging damage"
            />
          </div>
          <div>
            <Label>Condition / quality notes</Label>
            <Textarea
              rows={2}
              value={conditionNotes}
              onChange={(e) => setConditionNotes(e.target.value)}
              placeholder="Optional inspection notes"
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
            {saving ? "Recording…" : "Record factory return"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
