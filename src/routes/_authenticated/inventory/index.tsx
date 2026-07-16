import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { Plus, ArrowUpDown, ClipboardList, Upload } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { CAN_WRITE_INVENTORY, hasAny } from "@/lib/permissions";
import { ItemDialog } from "@/components/inventory/ItemDialog";
import { MovementDialog } from "@/components/inventory/MovementDialog";
import { StockCountDialog } from "@/components/inventory/StockCountDialog";
import { BulkImportDialog } from "@/components/inventory/BulkImportDialog";

export const Route = createFileRoute("/_authenticated/inventory/")({
  component: InventoryList,
});

export interface Item {
  id: string;
  item_id: string | null;
  sku: string;
  name: string;
  category: "raw_material" | "packaging" | "finished_good" | "consumable" | "semi_finished";
  subcategory: string | null;
  unit: string;
  quantity: number;
  reorder_level: number | null;
  min_level: number | null;
  status: string;
}

const CATEGORIES = ["all", "raw_material", "packaging", "finished_good", "consumable", "semi_finished"] as const;

function InventoryList() {
  const navigate = useNavigate();
  const session = useSession();
  const canEdit = hasAny(session.roles, CAN_WRITE_INVENTORY);
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [dialogItem, setDialogItem] = useState<Item | null | undefined>(undefined);
  const [moveItem, setMoveItem] = useState<Item | null>(null);
  const [countItem, setCountItem] = useState<Item | null>(null);
  const [showImport, setShowImport] = useState(false);

  async function load() {
    const { data } = await (supabase as any)
      .from("v_item_stock")
      .select("id, item_id, sku, name, category, subcategory, unit, min_level, reorder_level, status, on_hand")
      .order("item_id", { nullsFirst: false });
    setItems(((data ?? []) as any[]).map((r) => ({
      id: r.id, item_id: r.item_id, sku: r.sku, name: r.name,
      category: r.category, subcategory: r.subcategory, unit: r.unit,
      quantity: Number(r.on_hand ?? 0), reorder_level: r.reorder_level,
      min_level: r.min_level, status: r.status,
    })));
  }

  useEffect(() => {
    load();
    const ch = supabase
      .channel("inventory-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "inventory_movements" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "inventory_items" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
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
            {items.length} SKUs · {filtered.length} shown · stock changes via movements only
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowImport(true)}>
              <Upload className="size-4 mr-2" /> Bulk import
            </Button>
            <Button onClick={() => setDialogItem(null)} className="bg-brand-orange text-white hover:bg-brand-orange/90">
              <Plus className="size-4 mr-2" /> New item
            </Button>
          </div>
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
                <TableRow
                  key={it.id}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => navigate({ to: "/inventory/$itemId", params: { itemId: it.id } })}
                >
                  <TableCell className="font-mono text-xs">{it.sku}</TableCell>
                  <TableCell className="font-medium">{it.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.category.replace("_", " ")}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{Number(it.quantity).toLocaleString()}</TableCell>
                  <TableCell className="text-xs">{it.unit}</TableCell>
                  <TableCell>
                    {it.status !== "active" ? (
                      <Badge variant="outline">Inactive</Badge>
                    ) : low ? (
                      <Badge className="bg-brand-orange/15 text-brand-orange hover:bg-brand-orange/15 border-0">Low</Badge>
                    ) : (
                      <Badge className="bg-brand-green/15 text-brand-green hover:bg-brand-green/15 border-0">OK</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    {canEdit && (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" title="Record movement" onClick={() => setMoveItem(it)}>
                          <ArrowUpDown className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" title="Stock count" onClick={() => setCountItem(it)}>
                          <ClipboardList className="size-3.5" />
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
        <ItemDialog item={dialogItem as any} onClose={() => setDialogItem(undefined)} onSaved={load} />
      )}
      {moveItem && (
        <MovementDialog item={moveItem} onClose={() => setMoveItem(null)} onSaved={load} />
      )}
      {countItem && (
        <StockCountDialog item={countItem} onClose={() => setCountItem(null)} onSaved={load} />
      )}
      {showImport && (
        <BulkImportDialog onClose={() => setShowImport(false)} onImported={load} />
      )}
    </div>
  );
}
