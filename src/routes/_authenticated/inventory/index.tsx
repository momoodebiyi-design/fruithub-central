import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, ArrowUpDown } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { CAN_WRITE_INVENTORY, hasAny } from "@/lib/permissions";
import { ItemDialog } from "@/components/inventory/ItemDialog";
import { MovementDialog } from "@/components/inventory/MovementDialog";

export const Route = createFileRoute("/_authenticated/inventory/")({
  component: InventoryList,
});

export interface Item {
  id: string;
  sku: string;
  name: string;
  category: "raw_material" | "packaging" | "finished_good" | "consumable";
  unit: string;
  quantity: number;
  reorder_level: number | null;
  min_level: number | null;
  location: string | null;
  is_active: boolean;
}

const CATEGORIES = ["all", "raw_material", "packaging", "finished_good", "consumable"] as const;

function InventoryList() {
  const session = useSession();
  const canEdit = hasAny(session.roles, CAN_WRITE_INVENTORY);
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [dialogItem, setDialogItem] = useState<Item | null | undefined>(undefined);
  const [moveItem, setMoveItem] = useState<Item | null>(null);

  async function load() {
    const { data } = await supabase
      .from("inventory_items")
      .select("id, sku, name, category, unit, quantity, reorder_level, min_level, location, is_active")
      .order("name");
    setItems((data ?? []) as unknown as Item[]);
  }

  useEffect(() => {
    load();
    const ch = supabase
      .channel("inventory-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "inventory_items" }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (cat !== "all" && it.category !== cat) return false;
      if (q && !`${it.name} ${it.sku}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [items, q, cat]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {items.length} SKUs · {filtered.length} shown
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => setDialogItem(null)} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            <Plus className="size-4 mr-2" /> New item
          </Button>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <Input placeholder="Search SKU or name…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <Select value={cat} onValueChange={setCat}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>{c === "all" ? "All categories" : c.replace("_", " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="bg-card rounded-lg ring-1 ring-black/5 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((it) => {
              const low = it.reorder_level !== null && Number(it.quantity) <= Number(it.reorder_level);
              return (
                <TableRow key={it.id}>
                  <TableCell className="font-mono text-xs">{it.sku}</TableCell>
                  <TableCell className="font-medium">{it.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.category.replace("_", " ")}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{Number(it.quantity).toLocaleString()}</TableCell>
                  <TableCell className="text-xs">{it.unit}</TableCell>
                  <TableCell>
                    {!it.is_active ? (
                      <Badge variant="outline">Inactive</Badge>
                    ) : low ? (
                      <Badge className="bg-brand-orange/15 text-brand-orange hover:bg-brand-orange/15 border-0">Low</Badge>
                    ) : (
                      <Badge className="bg-brand-green/15 text-brand-green hover:bg-brand-green/15 border-0">OK</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {canEdit && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setMoveItem(it)}>
                          <ArrowUpDown className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDialogItem(it)}>Edit</Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">No items</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {dialogItem !== undefined && (
        <ItemDialog item={dialogItem} onClose={() => setDialogItem(undefined)} onSaved={load} />
      )}
      {moveItem && (
        <MovementDialog item={moveItem} onClose={() => setMoveItem(null)} onSaved={load} />
      )}
    </div>
  );
}
