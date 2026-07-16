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
import { Button } from "@/components/ui/button";
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
}

interface Ingredient {
  id?: string;
  ingredient_item_id: string;
  quantity: string;
  unit: string;
  waste_pct: string;
  notes: string;
  sort_order: number;
}

interface RecipeRef {
  id: string;
  product?: { name: string; sku: string } | null;
  version: number;
  status: string;
}

export function IngredientsDialog({
  recipe,
  canEdit,
  onClose,
  onSaved,
}: {
  recipe: RecipeRef;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [rows, setRows] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [itemsRes, ingRes] = await Promise.all([
        supabase
          .from("inventory_items")
          .select("id, sku, name, unit, category")
          .eq("is_active", true)
          .in("category", ["raw_material", "packaging", "consumables", "semi_finished"] as any)
          .order("name"),
        supabase
          .from("recipe_ingredients")
          .select("id, ingredient_item_id, quantity, unit, waste_pct, notes, sort_order")
          .eq("recipe_id", recipe.id)
          .order("sort_order"),
      ]);
      setItems((itemsRes.data ?? []) as unknown as Item[]);
      setRows(
        (ingRes.data ?? []).map((r: any) => ({
          id: r.id,
          ingredient_item_id: r.ingredient_item_id,
          quantity: r.quantity != null ? String(r.quantity) : "",
          unit: r.unit ?? "",
          waste_pct: r.waste_pct != null ? String(r.waste_pct) : "",
          notes: r.notes ?? "",
          sort_order: r.sort_order,
        }))
      );
      setLoading(false);
    })();
  }, [recipe.id]);

  function addRow() {
    setRows([
      ...rows,
      {
        ingredient_item_id: "",
        quantity: "",
        unit: "",
        waste_pct: "",
        notes: "",
        sort_order: rows.length,
      },
    ]);
  }

  function updateRow(idx: number, patch: Partial<Ingredient>) {
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function removeRow(idx: number) {
    setRows(rows.filter((_, i) => i !== idx));
  }

  async function save() {
    const valid = rows.filter((r) => r.ingredient_item_id);
    if (valid.length === 0) return toast.error("Add at least one ingredient");
    setSaving(true);
    // Simple replace strategy
    const { error: delErr } = await supabase
      .from("recipe_ingredients")
      .delete()
      .eq("recipe_id", recipe.id);
    if (delErr) {
      setSaving(false);
      return toast.error(delErr.message);
    }
    const payload = valid.map((r, i) => ({
      recipe_id: recipe.id,
      ingredient_item_id: r.ingredient_item_id,
      quantity: r.quantity ? Number(r.quantity) : null,
      unit: r.unit || null,
      waste_pct: r.waste_pct ? Number(r.waste_pct) : null,
      notes: r.notes || null,
      sort_order: i,
    }));
    const { error } = await supabase.from("recipe_ingredients").insert(payload);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Ingredients saved");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Ingredients — {recipe.product?.name ?? "Recipe"}
            <span className="text-muted-foreground font-normal ml-2 font-mono text-sm">
              v{recipe.version}
            </span>
          </DialogTitle>
        </DialogHeader>

        {!canEdit && (
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            {recipe.status === "approved"
              ? "This recipe is approved and locked. Create a new version to make changes."
              : "You don't have permission to edit this recipe."}
          </div>
        )}

        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_120px_100px_100px_1fr_auto] gap-2 text-xs uppercase tracking-wider text-muted-foreground font-medium px-1">
              <div>Ingredient</div>
              <div>Quantity</div>
              <div>Unit</div>
              <div>Waste %</div>
              <div>Notes</div>
              <div />
            </div>
            {rows.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No ingredients yet.
              </div>
            )}
            {rows.map((r, i) => {
              const it = items.find((x) => x.id === r.ingredient_item_id);
              return (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_120px_100px_100px_1fr_auto] gap-2 items-center"
                >
                  <Select
                    value={r.ingredient_item_id}
                    onValueChange={(v) => {
                      const chosen = items.find((x) => x.id === v);
                      updateRow(i, {
                        ingredient_item_id: v,
                        unit: r.unit || (chosen?.unit ?? ""),
                      });
                    }}
                    disabled={!canEdit}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Pick ingredient" />
                    </SelectTrigger>
                    <SelectContent>
                      {items.map((x) => (
                        <SelectItem key={x.id} value={x.id}>
                          {x.name}
                          <span className="text-muted-foreground text-xs ml-2 font-mono">
                            {x.sku}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    step="0.0001"
                    min="0"
                    value={r.quantity}
                    onChange={(e) => updateRow(i, { quantity: e.target.value })}
                    className="font-mono"
                    placeholder="blank ok"
                    disabled={!canEdit}
                  />
                  <Input
                    value={r.unit}
                    onChange={(e) => updateRow(i, { unit: e.target.value })}
                    placeholder={it?.unit ?? "unit"}
                    disabled={!canEdit}
                  />
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={r.waste_pct}
                    onChange={(e) => updateRow(i, { waste_pct: e.target.value })}
                    className="font-mono"
                    placeholder="0"
                    disabled={!canEdit}
                  />
                  <Input
                    value={r.notes}
                    onChange={(e) => updateRow(i, { notes: e.target.value })}
                    placeholder="Optional"
                    disabled={!canEdit}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeRow(i)}
                    disabled={!canEdit}
                  >
                    <Trash2 className="size-4 text-muted-foreground" />
                  </Button>
                </div>
              );
            })}

            {canEdit && (
              <Button variant="ghost" size="sm" onClick={addRow} className="mt-2">
                <Plus className="size-3.5 mr-1" /> Add ingredient
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {canEdit && (
            <Button
              onClick={save}
              disabled={saving}
              className="bg-brand-orange text-white hover:bg-brand-orange/90"
            >
              {saving ? "Saving…" : "Save ingredients"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
