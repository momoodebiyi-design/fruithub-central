import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Plus } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { CAN_RECORD_PRODUCTION, hasAny } from "@/lib/permissions";
import { RecordProductionDialog } from "@/components/production/RecordProductionDialog";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/production")({
  component: ProductionPage,
});

interface Batch {
  id: string;
  batch_number: string;
  quantity_produced: number;
  produced_at: string;
  status: string;
  qc_notes: string | null;
  product: { name: string; sku: string; unit: string } | null;
  staff: { full_name: string | null } | null;
}

function ProductionPage() {
  const session = useSession();
  const canRecord = hasAny(session.roles, CAN_RECORD_PRODUCTION);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [open, setOpen] = useState(false);

  async function load() {
    const { data } = await supabase
      .from("production_batches")
      .select(
        "id, batch_number, quantity_produced, produced_at, status, qc_notes, product:inventory_items!production_batches_product_item_id_fkey(name, sku, unit), staff:profiles!production_batches_staff_id_fkey(full_name)",
      )
      .order("produced_at", { ascending: false })
      .limit(50);
    setBatches((data ?? []) as unknown as Batch[]);
  }

  useEffect(() => {
    load();
    const ch = supabase
      .channel("prod-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "production_batches" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Production</h1>
          <p className="text-sm text-muted-foreground mt-1">Batches consume raw materials and yield finished goods atomically.</p>
        </div>
        {canRecord && (
          <Button onClick={() => setOpen(true)} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            <Plus className="size-4 mr-2" /> Record batch
          </Button>
        )}
      </div>

      <div className="bg-card rounded-lg ring-1 ring-black/5 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Batch</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Operator</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-xs">{b.batch_number}</TableCell>
                <TableCell className="font-medium">
                  {b.product?.name ?? "—"}
                  {b.product && <span className="ml-2 text-[11px] text-muted-foreground font-mono">{b.product.sku}</span>}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {Number(b.quantity_produced).toLocaleString()}{" "}
                  <span className="text-xs text-muted-foreground">{b.product?.unit}</span>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[10px] uppercase tracking-wider">{b.status}</Badge>
                </TableCell>
                <TableCell className="text-xs">{b.staff?.full_name ?? "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(b.produced_at), { addSuffix: true })}
                </TableCell>
              </TableRow>
            ))}
            {batches.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">No batches recorded yet</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {open && <RecordProductionDialog onClose={() => setOpen(false)} onSaved={load} />}
    </div>
  );
}
