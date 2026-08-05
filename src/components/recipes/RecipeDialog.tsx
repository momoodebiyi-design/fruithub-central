/* eslint-disable @typescript-eslint/no-explicit-any */
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
  const [notes, setNotes] = useState(recipe?.notes ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("inventory_items")
        .select("id, sku, name, unit, category")
        .eq("is_active", true)
        .eq("category", "finished_good" as any)
        .order("name");
      setItems((data ?? []) as unknown as Item[]);
    })();
  }, []);

  async function submit() {
    if (!productId) return toast.error("Pick a product");
    const v = Number(version);
    if (!v || v < 1) return toast.error("Version must be ≥ 1");

    const payload = {
      product_item_id: productId,
      version: v,
      yield_quantity: 1,
      yield_unit: items.find((item) => item.id === productId)?.unit ?? "unit",
      waste_pct: 0,
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
    toast.success(isEdit ? "Packaging setup updated" : "Packaging setup created");
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit packaging setup" : "New packaging setup"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Product</Label>
            <Select value={productId} onValueChange={setProductId} disabled={isEdit}>
              <SelectTrigger>
                <SelectValue placeholder="Finished product" />
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

          <div className="max-w-32">
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
            {saving ? "Saving…" : isEdit ? "Save" : "Create setup"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
