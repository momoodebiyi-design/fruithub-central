import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Send, Undo2, ChevronRight } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { CAN_DISPATCH, hasAny } from "@/lib/permissions";
import { DispatchDialog } from "@/components/dispatches/DispatchDialog";
import { ReturnDialog } from "@/components/dispatches/ReturnDialog";
import { toast } from "sonner";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/dispatches")({
  component: DispatchesPage,
});

interface DispatchRow {
  id: string;
  reference: string;
  dispatched_at: string;
  vehicle: string | null;
  notes: string | null;
  status: string;
  shops: { name: string } | null;
  dispatch_lines: { quantity_dispatched: number; quantity_returned: number }[];
}

const STATUS_COLORS: Record<string, string> = {
  draft: "text-muted-foreground border-muted",
  dispatched: "text-brand-orange border-brand-orange/30 bg-brand-orange/5",
  received: "text-blue-700 border-blue-200 bg-blue-50",
  reconciled: "text-emerald-700 border-emerald-200 bg-emerald-50",
  cancelled: "text-muted-foreground border-muted",
};

function DispatchesPage() {
  const session = useSession();
  const canDispatch = hasAny(session.roles, CAN_DISPATCH);
  const [rows, setRows] = useState<DispatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openNew, setOpenNew] = useState(false);
  const [returning, setReturning] = useState<{ id: string; reference: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("dispatches")
      .select("id, reference, dispatched_at, vehicle, notes, status, shops(name), dispatch_lines(quantity_dispatched, quantity_returned)")
      .order("dispatched_at", { ascending: false })
      .limit(100);
    if (error) toast.error(error.message);
    setRows((data as unknown as DispatchRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function markReceived(id: string) {
    const { error } = await supabase
      .from("dispatches")
      .update({ status: "received", received_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Marked as received");
    load();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dispatches</h1>
          <p className="text-sm text-muted-foreground">Shipments sent to your shops. Stock moves out atomically when recorded.</p>
        </div>
        {canDispatch && (
          <Button onClick={() => setOpenNew(true)} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            <Plus className="size-4 mr-2" />
            New dispatch
          </Button>
        )}
      </div>

      <div className="rounded-lg border overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground tracking-wider">
            <tr>
              <th className="w-8" />
              <th className="text-left px-4 py-2 font-medium">Reference</th>
              <th className="text-left px-4 py-2 font-medium">Shop</th>
              <th className="text-left px-4 py-2 font-medium">Date</th>
              <th className="text-left px-4 py-2 font-medium">Lines</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                  <Send className="mx-auto size-8 mb-2 opacity-50" />
                  No dispatches yet.
                </td>
              </tr>
            ) : (
              rows.map((d) => {
                const totalOut = d.dispatch_lines.reduce((s, l) => s + Number(l.quantity_dispatched), 0);
                const totalReturned = d.dispatch_lines.reduce((s, l) => s + Number(l.quantity_returned), 0);
                const isExpanded = expanded === d.id;
                return (
                  <>
                    <tr
                      key={d.id}
                      className="hover:bg-muted/30 cursor-pointer"
                      onClick={() => setExpanded(isExpanded ? null : d.id)}
                    >
                      <td className="px-2"><ChevronRight className={`size-4 transition-transform ${isExpanded ? "rotate-90" : ""}`} /></td>
                      <td className="px-4 py-3 font-mono text-xs">{d.reference}</td>
                      <td className="px-4 py-3">{d.shops?.name ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {format(new Date(d.dispatched_at), "d MMM yyyy · HH:mm")}
                      </td>
                      <td className="px-4 py-3 font-mono">
                        {d.dispatch_lines.length}
                        <span className="text-muted-foreground text-xs ml-1">({totalOut} out / {totalReturned} back)</span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={STATUS_COLORS[d.status] ?? ""}>{d.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {canDispatch && d.status === "dispatched" && (
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); markReceived(d.id); }}>
                            Mark received
                          </Button>
                        )}
                        {canDispatch && (d.status === "dispatched" || d.status === "received") && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => { e.stopPropagation(); setReturning({ id: d.id, reference: d.reference }); }}
                          >
                            <Undo2 className="size-3 mr-1" /> Return
                          </Button>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={d.id + "-x"} className="bg-muted/20">
                        <td />
                        <td colSpan={6} className="px-4 py-3">
                          <ExpandedLines dispatchId={d.id} vehicle={d.vehicle} notes={d.notes} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {openNew && <DispatchDialog onClose={() => setOpenNew(false)} onSaved={load} />}
      {returning && (
        <ReturnDialog
          dispatchId={returning.id}
          reference={returning.reference}
          onClose={() => setReturning(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function ExpandedLines({ dispatchId, vehicle, notes }: { dispatchId: string; vehicle: string | null; notes: string | null }) {
  const [lines, setLines] = useState<Array<{ id: string; quantity_dispatched: number; quantity_returned: number; inventory_items: { name: string; unit: string } | null }>>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("dispatch_lines")
        .select("id, quantity_dispatched, quantity_returned, inventory_items(name, unit)")
        .eq("dispatch_id", dispatchId);
      setLines((data as any) ?? []);
    })();
  }, [dispatchId]);

  return (
    <div className="space-y-2">
      {(vehicle || notes) && (
        <div className="text-xs text-muted-foreground">
          {vehicle && <span>Vehicle: <span className="text-foreground">{vehicle}</span> · </span>}
          {notes && <span>{notes}</span>}
        </div>
      )}
      <div className="rounded-md border bg-background overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-[10px] uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-1.5">Item</th>
              <th className="text-right px-3 py-1.5">Dispatched</th>
              <th className="text-right px-3 py-1.5">Returned</th>
              <th className="text-right px-3 py-1.5">Net at shop</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-1.5">{l.inventory_items?.name ?? "—"}</td>
                <td className="px-3 py-1.5 text-right font-mono">{Number(l.quantity_dispatched)} {l.inventory_items?.unit}</td>
                <td className="px-3 py-1.5 text-right font-mono">{Number(l.quantity_returned)} {l.inventory_items?.unit}</td>
                <td className="px-3 py-1.5 text-right font-mono">
                  {Number(l.quantity_dispatched) - Number(l.quantity_returned)} {l.inventory_items?.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
