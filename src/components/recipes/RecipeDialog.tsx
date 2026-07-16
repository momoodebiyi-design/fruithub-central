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

interface Item {
  id: string;
  sku: string;
  name: string;
  unit: string;
  category: string;
}

interface ExistingRecipe {
  id: string;
  product_item_id: string;
  version: number;
  yield_quantity: number | null;
  yield_unit: string | null;
  waste_pct: number | null;
  notes: string | null;
}

export function RecipeDialog({
  recipe,
  onClose,
  onSaved,
}: {
  recipe?: ExistingRecipe;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!recipe;
  const [items, setItems] = useState<Item[]>([]);
  const [productId, setProductId] = useState(recipe?.product_item_id ?? "");
  const [version, setVersion] = useState<string>(String(recipe?.version ?? 1));
  const [yieldQty, setYieldQty] = useState<string>(
    recipe?.yield_quantity != null ? String(recipe.yield_quantity) : ""
  );
  const [yieldUnit, setYieldUnit] = useState<string>(recipe?.yield_unit ?? "");
  const [wastePct, setWastePct] = useState<string>(
    recipe?.waste_pct != null ? String(recipe.waste_pct) : ""
  );
  const [notes, setNotes] = useState(recipe?.notes ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("inventory_items")
        .select("id, sku, name, unit, category")
        .eq("is_active", true)
        .in("category", ["finished_good", "semi_finished"] as any)
        .order("name");
      setItems((data ?? []) as unknown as Item[]);
    })();
  }, []);

  useEffect(() => {
    if (!yieldUnit && productId) {
      const it = items.find((i) => i.id === productId);
      if (it) setYieldUnit(it.unit);
    }
  }, [productId, items]);

  async function submit() {
    if (!productId) return toast.error("Pick a product");
    const v = Number(version);
    if (!v || v < 1) return toast.error("Version must be ≥ 1");

    const payload = {
      product_item_id: productId,
      version: v,
      yield_quantity: yieldQty ? Number(yieldQty) : null,
      yield_unit: yieldUnit || null,
      waste_pct: wastePct ? Number(wastePct) : null,
      notes: notes || null,
    };

    setSaving(true);
    let error;
    if (isEdit) {
      ({ error } = await supabase.from("recipes").update(payload).eq("id", recipe!.id));
    } else {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      ({ error } = await supabase
        .from("recipes")
        .insert({ ...payload, status: "draft", created_by: user?.id ?? null }));
    }
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(isEdit ? "Recipe updated" : "Recipe created");
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit recipe" : "New recipe"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Product</Label>
            <Select value={productId} onValueChange={setProductId} disabled={isEdit}>
              <SelectTrigger>
                <SelectValue placeholder="Finished good or semi-finished" />
              </SelectTrigger>
              <SelectContent>
                {items.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.name}
                    <span className="text-muted-foreground text-xs ml-2 font-mono">{i.sku}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Version</Label>
              <Input
                type="number"
                min="1"
                step="1"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                className="font-mono"
              />
            </div>
            <div>
              <Label>Yield qty</Label>
              <Input
                type="number"
                step="0.001"
                min="0"
                value={yieldQty}
                onChange={(e) => setYieldQty(e.target.value)}
                className="font-mono"
                placeholder="blank ok"
              />
            </div>
            <div>
              <Label>Yield unit</Label>
              <Input
                value={yieldUnit}
                onChange={(e) => setYieldUnit(e.target.value)}
                placeholder="L, kg, unit"
              />
            </div>
          </div>

          <div>
            <Label>Overall waste %</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={wastePct}
              onChange={(e) => setWastePct(e.target.value)}
              className="font-mono"
              placeholder="0"
            />
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving}
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            {saving ? "Saving…" : isEdit ? "Save" : "Create recipe"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
