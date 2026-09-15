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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

type Category = "raw_material" | "packaging" | "finished_good" | "consumable" | "semi_finished";

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

const CATS: Category[] = [
  "raw_material",
  "packaging",
  "finished_good",
  "consumable",
  "semi_finished",
];
const UNITS = ["kg", "g", "L", "mL", "unit", "bottle", "case", "pallet"];

export function ItemDialog({
  item,
  onClose,
  onSaved,
  canDelete = false,
  onDeleted,
}: {
  item: Item | null;
  onClose: () => void;
  onSaved: () => void;
  canDelete?: boolean;
  onDeleted?: () => void;
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
  const [deleting, setDeleting] = useState(false);
  const [deletionReason, setDeletionReason] = useState("");

  useEffect(() => {
    if (item) setForm(item);
  }, [item]);

  async function save() {
    setSaving(true);
    const payload = {
      sku: form.sku.trim().toUpperCase(),
      name: form.name.trim(),
      category: form.category,
      unit: form.unit,
      reorder_level: form.reorder_level ?? 0,
      min_level: form.min_level ?? 0,
      location: form.location,
      is_active: form.is_active ?? true,
    };
    const { error } = editing
      ? await supabase.from("inventory_items").update(payload).eq("id", item!.id!)
      : await supabase.from("inventory_items").insert(payload);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(editing ? "Item updated" : "Item created");
    onSaved();
    onClose();
  }

  async function deleteItem() {
    if (!item?.id || deletionReason.trim().length < 5) return;
    setDeleting(true);
    const { error } = await supabase.rpc("delete_inventory_item", {
      _item_id: item.id,
      _reason: deletionReason.trim(),
    });
    setDeleting(false);
    if (error) return toast.error(error.message);
    toast.success("Item deleted from active inventory. Its history is preserved.");
    onDeleted?.();
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit item" : "New inventory item"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>SKU</Label>
              <Input
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                placeholder="FR-ORNG-01"
              />
            </div>
            <div>
              <Label>Unit</Label>
              <Select value={form.unit} onValueChange={(v) => setForm({ ...form, unit: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNITS.map((u) => (
                    <SelectItem key={u} value={u}>
                      {u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>Category</Label>
            <Select
              value={form.category}
              onValueChange={(v) => setForm({ ...form, category: v as Category })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.replace("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Reorder level</Label>
              <Input
                type="number"
                value={form.reorder_level ?? ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    reorder_level: e.target.value ? Number(e.target.value) : null,
                  })
                }
              />
            </div>
            <div>
              <Label>Min level</Label>
              <Input
                type="number"
                value={form.min_level ?? ""}
                onChange={(e) =>
                  setForm({ ...form, min_level: e.target.value ? Number(e.target.value) : null })
                }
              />
            </div>
          </div>
          <div>
            <Label>Location</Label>
            <Input
              value={form.location ?? ""}
              onChange={(e) => setForm({ ...form, location: e.target.value || null })}
              placeholder="e.g. Cold storage A"
            />
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <div>
            {editing && canDelete && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" type="button">
                    <Trash2 className="mr-2 size-4" /> Delete item
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {form.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The item will leave active inventory, but its movement and audit history will
                      be retained. Items with remaining stock cannot be deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="space-y-2">
                    <Label htmlFor="deletion-reason">Reason for deletion</Label>
                    <Textarea
                      id="deletion-reason"
                      value={deletionReason}
                      onChange={(event) => setDeletionReason(event.target.value)}
                      placeholder="For example: duplicate SKU created in error"
                      rows={3}
                    />
                    <p className="text-xs text-muted-foreground">
                      Required for the audit log (minimum 5 characters).
                    </p>
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={deleting}>Keep item</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(event) => {
                        event.preventDefault();
                        void deleteItem();
                      }}
                      disabled={deleting || deletionReason.trim().length < 5}
                      className="bg-destructive text-white hover:bg-destructive/90"
                    >
                      {deleting ? "Deleting…" : "Delete item"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving || !form.sku || !form.name}
              className="bg-brand-orange text-white hover:bg-brand-orange/90"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
