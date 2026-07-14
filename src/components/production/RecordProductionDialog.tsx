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
import { Trash2, Plus } from "lucide-react";

interface Item {
  id: string;
  sku: string;
  name: string;
  unit: string;
  category: string;
  quantity: number;
}

interface ConsumptionRow {
  item_id: string;
  quantity: string;
}

export function RecordProductionDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [outputItemId, setOutputItemId] = useState("");
  const [outputQty, setOutputQty] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [qcNotes, setQcNotes] = useState("");
  const [rows, setRows] = useState<ConsumptionRow[]>([{ item_id: "", quantity: "" }]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("inventory_items")
        .select("id, sku, name, unit, category, quantity")
        .eq("is_active", true)
        .order("name");
      setItems((data ?? []) as unknown as Item[]);
    })();
    const d = new Date();
    setBatchNumber(
      `B-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`,
    );
  }, []);

  const outputItems = items.filter((i) => i.category === "finished_good");
  const inputItems = items.filter((i) => i.category !== "finished_good");

  async function submit() {
    if (!outputItemId) return toast.error("Pick an output product");
    const outQ = Number(outputQty);
    if (!outQ || outQ <= 0) return toast.error("Enter output quantity");
    const consumption = rows
      .filter((r) => r.item_id && r.quantity)
      .map((r) => ({ item_id: r.item_id, quantity: Number(r.quantity) }));
    if (consumption.some((c) => !c.quantity || c.quantity <= 0)) return toast.error("Invalid consumption quantity");

    setSaving(true);
    const { error } = await supabase.rpc("record_production", {
      _batch_number: batchNumber,
      _product_item_id: outputItemId,
      _quantity: outQ,
      _consumption: consumption as any,
      _qc_notes: qcNotes || undefined,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Batch recorded — stock updated");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Record production batch</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Batch number</Label>
            <Input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} className="font-mono" />
          </div>

          <div className="border rounded-md p-4 space-y-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Output</p>
            <div className="grid grid-cols-[1fr_140px] gap-3">
              <Select value={outputItemId} onValueChange={setOutputItemId}>
                <SelectTrigger><SelectValue placeholder="Finished product" /></SelectTrigger>
                <SelectContent>
                  {outputItems.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name} <span className="text-muted-foreground text-xs ml-1 font-mono">{i.sku}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input type="number" step="0.01" min="0" placeholder="Quantity" value={outputQty} onChange={(e) => setOutputQty(e.target.value)} />
            </div>
          </div>

          <div className="border rounded-md p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Consumed materials</p>
              <Button variant="ghost" size="sm" onClick={() => setRows([...rows, { item_id: "", quantity: "" }])}>
                <Plus className="size-3.5 mr-1" /> Add
              </Button>
            </div>
            {rows.map((r, i) => {
              const it = items.find((x) => x.id === r.item_id);
              return (
                <div key={i} className="grid grid-cols-[1fr_140px_auto] gap-2 items-center">
                  <Select value={r.item_id} onValueChange={(v) => setRows(rows.map((row, idx) => idx === i ? { ...row, item_id: v } : row))}>
                    <SelectTrigger><SelectValue placeholder="Material" /></SelectTrigger>
                    <SelectContent>
                      {inputItems.map((x) => (
                        <SelectItem key={x.id} value={x.id}>
                          {x.name} <span className="text-muted-foreground text-xs ml-1">({Number(x.quantity).toLocaleString()} {x.unit})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input type="number" step="0.01" min="0" placeholder={it ? `qty (${it.unit})` : "qty"} value={r.quantity} onChange={(e) => setRows(rows.map((row, idx) => idx === i ? { ...row, quantity: e.target.value } : row))} />
                  <Button variant="ghost" size="icon" onClick={() => setRows(rows.filter((_, idx) => idx !== i))}>
                    <Trash2 className="size-4 text-muted-foreground" />
                  </Button>
                </div>
              );
            })}
          </div>

          <div>
            <Label>QC notes</Label>
            <Textarea value={qcNotes} onChange={(e) => setQcNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            {saving ? "Recording…" : "Record batch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
