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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

type Category = "raw_material" | "packaging" | "finished_good" | "consumable";

interface Item {
  id?: string;
  sku: string;
  name: string;
  category: Category;
  unit: string;
  reorder_level: number | null;
  min_level: number | null;
  location: string | null;
  is_active?: boolean;
}

const CATS: Category[] = ["raw_material", "packaging", "finished_good", "consumable"];
const UNITS = ["kg", "g", "L", "mL", "unit", "bottle", "case", "pallet"];

export function ItemDialog({
  item,
  onClose,
  onSaved,
}: {
  item: Item | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!item?.id;
  const [form, setForm] = useState<Item>(
    item ?? {
      sku: "",
      name: "",
      category: "raw_material",
      unit: "kg",
      reorder_level: null,
      min_level: null,
      location: null,
      is_active: true,
    },
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (item) setForm(item); }, [item]);

  async function save() {
    setSaving(true);
    const payload = {
      sku: form.sku.trim().toUpperCase(),
      name: form.name.trim(),
      category: form.category,
      unit: form.unit,
      reorder_level: form.reorder_level,
      min_level: form.min_level,
      location: form.location,
      is_active: form.is_active ?? true,
    };
    const { error } = editing
      ? await supabase.from("inventory_items").update(payload as any).eq("id", item!.id!)
      : await supabase.from("inventory_items").insert(payload as any);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(editing ? "Item updated" : "Item created");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{editing ? "Edit item" : "New inventory item"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>SKU</Label>
              <Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="FR-ORNG-01" />
            </div>
            <div>
              <Label>Unit</Label>
              <Select value={form.unit} onValueChange={(v) => setForm({ ...form, unit: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>Category</Label>
            <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v as Category })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{CATS.map((c) => <SelectItem key={c} value={c}>{c.replace("_", " ")}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Reorder level</Label>
              <Input type="number" value={form.reorder_level ?? ""} onChange={(e) => setForm({ ...form, reorder_level: e.target.value ? Number(e.target.value) : null })} />
            </div>
            <div>
              <Label>Min level</Label>
              <Input type="number" value={form.min_level ?? ""} onChange={(e) => setForm({ ...form, min_level: e.target.value ? Number(e.target.value) : null })} />
            </div>
          </div>
          <div>
            <Label>Location</Label>
            <Input value={form.location ?? ""} onChange={(e) => setForm({ ...form, location: e.target.value || null })} placeholder="e.g. Cold storage A" />
          </div>
          {editing && (
            <div className="flex items-center justify-between">
              <Label htmlFor="active">Active</Label>
              <Switch id="active" checked={form.is_active ?? true} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || !form.sku || !form.name} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
