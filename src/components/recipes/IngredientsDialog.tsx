/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Trash2, Plus, ChevronsUpDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

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

const COMMON_UNITS = [
  "g",
  "kg",
  "mg",
  "oz",
  "lb",
  "ml",
  "l",
  "cl",
  "pcs",
  "unit",
  "pack",
  "box",
  "bottle",
  "carton",
  "tsp",
  "tbsp",
  "cup",
];

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
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const [itemsRes, ingRes] = await Promise.all([
        supabase
          .from("inventory_items")
          .select("id, sku, name, unit, category")
          .eq("is_active", true)
          .in("category", ["packaging", "consumable"] as any)
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
        })),
      );
      setLoading(false);
    })();
  }, [recipe.id]);

  const unitOptions = useMemo(() => {
    const set = new Set<string>(COMMON_UNITS);
    items.forEach((i) => i.unit && set.add(i.unit));
    rows.forEach((r) => r.unit && set.add(r.unit));
    return Array.from(set).sort();
  }, [items, rows]);

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
    if (valid.length === 0) return toast.error("Add at least one packaging or consumable item");
    setSaving(true);
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
      waste_pct: 0,
      notes: r.notes || null,
      sort_order: i,
    }));
    const { error } = await supabase.from("recipe_ingredients").insert(payload);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Packaging setup saved");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Packaging items — {recipe.product?.name ?? "Product"}
            <span className="text-muted-foreground font-normal ml-2 font-mono text-sm">
              v{recipe.version}
            </span>
          </DialogTitle>
        </DialogHeader>

        {!canEdit && (
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            {recipe.status === "approved"
              ? "This setup is approved and locked. Create a new version to make changes."
              : "You don't have permission to edit this setup."}
          </div>
        )}

        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_130px_120px_1fr_auto] gap-2 text-xs uppercase tracking-wider text-muted-foreground font-medium px-1">
              <div>Packaging / consumable</div>
              <div>Per finished unit</div>
              <div>Unit</div>
              <div>Notes</div>
              <div />
            </div>
            {rows.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No packaging items yet.
              </div>
            )}
            {rows.map((r, i) => {
              const it = items.find((x) => x.id === r.ingredient_item_id);
              return (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_130px_120px_1fr_auto] gap-2 items-center"
                >
                  <Popover open={openIdx === i} onOpenChange={(o) => setOpenIdx(o ? i : null)}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        disabled={!canEdit}
                        className="w-full justify-between font-normal"
                      >
                        <span className="truncate">
                          {it ? (
                            <>
                              {it.name}
                              <span className="text-muted-foreground text-xs ml-2 font-mono">
                                {it.sku}
                              </span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">Pick packaging…</span>
                          )}
                        </span>
                        <ChevronsUpDown className="size-3.5 opacity-50 shrink-0 ml-2" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="p-0 w-[380px]" align="start">
                      <Command
                        filter={(value, search) =>
                          value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                        }
                      >
                        <CommandInput placeholder="Search packaging…" />
                        <CommandList>
                          <CommandEmpty>No packaging item found.</CommandEmpty>
                          <CommandGroup>
                            {items.map((x) => (
                              <CommandItem
                                key={x.id}
                                value={`${x.name} ${x.sku}`}
                                onSelect={() => {
                                  updateRow(i, {
                                    ingredient_item_id: x.id,
                                    unit: r.unit || x.unit || "",
                                  });
                                  setOpenIdx(null);
                                }}
                              >
                                <Check
                                  className={cn(
                                    "size-3.5 mr-2",
                                    r.ingredient_item_id === x.id ? "opacity-100" : "opacity-0",
                                  )}
                                />
                                <span className="flex-1 truncate">{x.name}</span>
                                <span className="text-muted-foreground text-xs ml-2 font-mono">
                                  {x.sku}
                                </span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>

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

                  <Select
                    value={r.unit || undefined}
                    onValueChange={(v) => {
                      if (v === "__custom__") return;
                      updateRow(i, { unit: v });
                    }}
                    disabled={!canEdit}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={it?.unit ?? "unit"} />
                    </SelectTrigger>
                    <SelectContent>
                      {unitOptions.map((u) => (
                        <SelectItem key={u} value={u}>
                          {u}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

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
                <Plus className="size-3.5 mr-1" /> Add packaging item
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
              {saving ? "Saving…" : "Save packaging setup"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
