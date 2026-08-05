/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ClipboardCheck, Plus, Search, Send, XCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import { CAN_APPROVE_STOCKTAKES, CAN_WRITE_INVENTORY, hasAny } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/_authenticated/stocktakes")({ component: StocktakesPage });

type Stocktake = {
  id: string;
  count_number: string;
  scope: string;
  status: "draft" | "submitted" | "approved" | "rejected";
  notes: string | null;
  rejection_reason: string | null;
  created_at: string;
};

type Line = {
  id: string;
  expected_quantity: number;
  counted_quantity: number | null;
  difference: number | null;
  variance_reason: string | null;
  inventory_items: { name: string; sku: string; unit: string; category: string } | null;
};

function StocktakesPage() {
  const { roles } = useSession();
  const canCount = hasAny(roles, CAN_WRITE_INVENTORY);
  const canApprove = hasAny(roles, CAN_APPROVE_STOCKTAKES);
  const [stocktakes, setStocktakes] = useState<Stocktake[]>([]);
  const [selected, setSelected] = useState<Stocktake | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [scope, setScope] = useState("all");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadStocktakes(preselect?: string) {
    const { data, error } = await (supabase as any)
      .from("central_stocktakes")
      .select("id, count_number, scope, status, notes, rejection_reason, created_at")
      .order("created_at", { ascending: false });
    if (error) return toast.error(error.message);
    const next = (data ?? []) as Stocktake[];
    setStocktakes(next);
    const id = preselect ?? selected?.id;
    setSelected(next.find((row) => row.id === id) ?? next[0] ?? null);
  }

  async function loadLines(id: string) {
    const { data, error } = await (supabase as any)
      .from("central_stocktake_lines")
      .select(
        "id, expected_quantity, counted_quantity, difference, variance_reason, inventory_items(name, sku, unit, category)",
      )
      .eq("stocktake_id", id)
      .order("id");
    if (error) return toast.error(error.message);
    setLines(
      ((data ?? []) as Line[])
        .map((line) => ({
          ...line,
          expected_quantity: Number(line.expected_quantity),
          counted_quantity: line.counted_quantity == null ? null : Number(line.counted_quantity),
          difference: line.difference == null ? null : Number(line.difference),
        }))
        .sort((a, b) =>
          (a.inventory_items?.name ?? "").localeCompare(b.inventory_items?.name ?? ""),
        ),
    );
  }

  useEffect(() => {
    loadStocktakes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (selected) loadLines(selected.id);
    else setLines([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const visibleLines = useMemo(() => {
    const needle = query.toLowerCase();
    return lines.filter(
      (line) =>
        !needle ||
        line.inventory_items?.name.toLowerCase().includes(needle) ||
        line.inventory_items?.sku.toLowerCase().includes(needle),
    );
  }, [lines, query]);

  function updateLine(id: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  async function createStocktake() {
    setBusy(true);
    const { data, error } = await (supabase as any).rpc("create_central_stocktake", {
      _scope: scope,
      _notes: notes,
      _client_reference_id: crypto.randomUUID(),
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    setCreating(false);
    setNotes("");
    setScope("all");
    toast.success("Central stocktake started");
    await loadStocktakes(data as string);
  }

  async function save() {
    if (!selected) return;
    const changed = lines.filter((line) => line.counted_quantity != null);
    for (const line of changed) {
      const difference = Number(line.counted_quantity) - line.expected_quantity;
      if (difference !== 0 && !line.variance_reason?.trim()) {
        return toast.error(
          `Explain the variance for ${line.inventory_items?.name ?? "each changed item"}`,
        );
      }
    }
    setBusy(true);
    const { error } = await (supabase as any).rpc("save_central_stocktake_lines", {
      _stocktake_id: selected.id,
      _lines: changed.map((line) => ({
        line_id: line.id,
        counted_quantity: line.counted_quantity,
        variance_reason: line.variance_reason?.trim() || null,
      })),
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Counts saved");
    await loadLines(selected.id);
  }

  async function runAction(action: "submit" | "approve" | "reject") {
    if (!selected) return;
    if (action === "submit" && lines.some((line) => line.counted_quantity == null)) {
      return toast.error("Every item must be counted. Blank is not treated as zero.");
    }
    let reason = "";
    if (action === "reject") {
      reason = window.prompt("Why is this stocktake being rejected?")?.trim() ?? "";
      if (!reason) return;
    }
    setBusy(true);
    const fn =
      action === "submit"
        ? "submit_central_stocktake"
        : action === "approve"
          ? "approve_central_stocktake"
          : "reject_central_stocktake";
    const args =
      action === "reject"
        ? { _stocktake_id: selected.id, _reason: reason }
        : { _stocktake_id: selected.id };
    const { error } = await (supabase as any).rpc(fn, args);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(
      action === "approve"
        ? "Stocktake approved — Central stock updated"
        : action === "submit"
          ? "Stocktake submitted for approval"
          : "Stocktake rejected",
    );
    await loadStocktakes(selected.id);
  }

  const counted = lines.filter((line) => line.counted_quantity != null).length;
  const varianceLines = lines.filter(
    (line) =>
      line.counted_quantity != null && Number(line.counted_quantity) !== line.expected_quantity,
  ).length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Central Stocktake</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Count factory stock, explain differences, then approve auditable adjustments.
          </p>
        </div>
        {canCount && (
          <Button
            onClick={() => setCreating(true)}
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            <Plus className="size-4 mr-1" /> Start stocktake
          </Button>
        )}
      </div>

      <div className="grid lg:grid-cols-[280px_1fr] gap-4">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Stocktakes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {stocktakes.length === 0 && (
              <p className="text-sm text-muted-foreground">No Central stocktakes yet.</p>
            )}
            {stocktakes.map((row) => (
              <button
                key={row.id}
                onClick={() => setSelected(row)}
                className={`w-full text-left rounded-md border p-3 ${selected?.id === row.id ? "border-brand-orange bg-brand-orange/5" : "hover:bg-muted/40"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs">{row.count_number}</span>
                  <Status status={row.status} />
                </div>
                <p className="text-xs text-muted-foreground mt-1 capitalize">
                  {row.scope.replace("_", " ")} · {new Date(row.created_at).toLocaleDateString()}
                </p>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <CardTitle className="text-base">
                  {selected?.count_number ?? "Select a stocktake"}
                </CardTitle>
                {selected && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {counted}/{lines.length} counted · {varianceLines} variances
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                {selected?.status === "draft" && canCount && (
                  <>
                    <Button variant="outline" onClick={save} disabled={busy}>
                      Save
                    </Button>
                    <Button onClick={() => runAction("submit")} disabled={busy}>
                      <Send className="size-4 mr-1" /> Submit
                    </Button>
                  </>
                )}
                {selected?.status === "submitted" && canApprove && (
                  <>
                    <Button variant="outline" onClick={() => runAction("reject")} disabled={busy}>
                      <XCircle className="size-4 mr-1" /> Reject
                    </Button>
                    <Button
                      onClick={() => runAction("approve")}
                      disabled={busy}
                      className="bg-emerald-600 text-white hover:bg-emerald-700"
                    >
                      <CheckCircle2 className="size-4 mr-1" /> Approve
                    </Button>
                  </>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {selected && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Enter an actual count for every item. A blank count is intentionally not converted
                to zero.
              </div>
            )}
            {selected && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search product or SKU"
                  className="pl-9"
                />
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="text-left p-2">Item</th>
                    <th className="text-right p-2">Expected</th>
                    <th className="text-right p-2 w-32">Counted</th>
                    <th className="text-right p-2">Difference</th>
                    <th className="text-left p-2 min-w-52">Reason if different</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLines.map((line) => {
                    const diff =
                      line.counted_quantity == null
                        ? null
                        : line.counted_quantity - line.expected_quantity;
                    return (
                      <tr key={line.id} className="border-b last:border-0">
                        <td className="p-2">
                          <p className="font-medium">{line.inventory_items?.name}</p>
                          <p className="text-[11px] text-muted-foreground font-mono">
                            {line.inventory_items?.sku} · {line.inventory_items?.unit}
                          </p>
                        </td>
                        <td className="p-2 text-right font-mono">
                          {line.expected_quantity.toLocaleString()}
                        </td>
                        <td className="p-2">
                          <Input
                            type="number"
                            min="0"
                            step="0.001"
                            disabled={selected?.status !== "draft" || !canCount}
                            value={line.counted_quantity ?? ""}
                            onChange={(e) =>
                              updateLine(line.id, {
                                counted_quantity:
                                  e.target.value === "" ? null : Number(e.target.value),
                              })
                            }
                            className="text-right font-mono"
                          />
                        </td>
                        <td
                          className={`p-2 text-right font-mono ${diff && diff !== 0 ? "text-brand-orange" : ""}`}
                        >
                          {diff == null ? "—" : diff > 0 ? `+${diff}` : diff}
                        </td>
                        <td className="p-2">
                          <Input
                            disabled={
                              selected?.status !== "draft" ||
                              !canCount ||
                              diff === 0 ||
                              diff == null
                            }
                            value={line.variance_reason ?? ""}
                            onChange={(e) =>
                              updateLine(line.id, { variance_reason: e.target.value })
                            }
                            placeholder={diff && diff !== 0 ? "Required" : "—"}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start Central stocktake</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Items to count</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All active items</SelectItem>
                  <SelectItem value="finished_good">Finished products</SelectItem>
                  <SelectItem value="packaging">Packaging</SelectItem>
                  <SelectItem value="consumable">Consumables</SelectItem>
                  <SelectItem value="raw_material">Raw materials</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional count instructions"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={createStocktake} disabled={busy}>
              {busy ? "Starting…" : "Start count"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Status({ status }: { status: Stocktake["status"] }) {
  return (
    <Badge variant="outline" className="text-[10px] capitalize">
      {status}
    </Badge>
  );
}
