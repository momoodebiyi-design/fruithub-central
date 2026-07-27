/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Check, ClipboardList, PackageCheck, Plus, Send, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import { CAN_APPROVE_REQUESTS, hasAny } from "@/lib/permissions";
import { RequestDialog } from "@/components/requests/RequestDialog";
import { ReviewRequestDialog } from "@/components/requests/ReviewRequestDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/_authenticated/replenishment")({
  component: ReplenishmentPage,
});

type RequestRow = {
  id: string;
  quantity: number;
  approved_quantity: number | null;
  received_quantity: number | null;
  purpose: string;
  replenishment_status: string;
  request_kind: string;
  created_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
  requested_by: string;
  inventory_items: { name: string; unit: string } | null;
  shops: { name: string } | null;
  requester: { full_name: string | null; email: string } | null;
};

type Suggestion = {
  id: string;
  need_number: string;
  item_id: string;
  suggested_quantity: number;
  available_stock_snapshot: number;
  in_transit_snapshot: number;
  priority: string;
  inventory_items: { name: string; unit: string } | null;
  locations: { name: string } | null;
};

const STATUS: Record<string, string> = {
  requested: "text-amber-700 border-amber-200 bg-amber-50",
  approved: "text-blue-700 border-blue-200 bg-blue-50",
  dispatched: "text-violet-700 border-violet-200 bg-violet-50",
  received: "text-emerald-700 border-emerald-200 bg-emerald-50",
  discrepancy: "text-red-700 border-red-200 bg-red-50",
  rejected: "text-red-700 border-red-200 bg-red-50",
};

function ReplenishmentPage() {
  const session = useSession();
  const canManage = hasAny(session.roles, CAN_APPROVE_REQUESTS);
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [openNew, setOpenNew] = useState(false);
  const [review, setReview] = useState<{ row: RequestRow; mode: "approve" | "reject" } | null>(
    null,
  );
  const [action, setAction] = useState<{ row: RequestRow; mode: "issue" | "receive" } | null>(null);

  async function load() {
    setLoading(true);
    const [{ data, error }, { data: needs }] = await Promise.all([
      (supabase as any)
        .from("stock_requests")
        .select(
          "id, quantity, approved_quantity, received_quantity, purpose, replenishment_status, request_kind, created_at, reviewed_at, review_notes, requested_by, inventory_items(name, unit), shops(name), requester:profiles!stock_requests_requested_by_fkey(full_name, email)",
        )
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(200),
      (supabase as any)
        .from("purchase_needs")
        .select(
          "id, need_number, item_id, suggested_quantity, available_stock_snapshot, in_transit_snapshot, priority, inventory_items(name, unit), locations:locations!purchase_needs_location_id_fkey(name)",
        )
        .eq("source_type", "replenishment")
        .in("status", ["draft", "ready"])
        .order("priority", { ascending: false }),
    ]);
    if (error) toast.error(error.message);
    setRows((data as RequestRow[]) ?? []);
    setSuggestions((needs as Suggestion[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Replenishment</h1>
          <p className="text-sm text-muted-foreground">
            Internal shop movements from Central. Approval, dispatch and receipt remain separate.
          </p>
        </div>
        <Button
          onClick={() => setOpenNew(true)}
          className="bg-brand-orange text-white hover:bg-brand-orange/90"
        >
          <Plus className="mr-2 size-4" />
          Urgent midday request
        </Button>
      </div>

      <Tabs defaultValue={canManage ? "queue" : "mine"}>
        <TabsList>
          {canManage && (
            <TabsTrigger value="queue">
              Inventory queue (
              {
                rows.filter((row) => ["requested", "approved"].includes(row.replenishment_status))
                  .length
              }
              )
            </TabsTrigger>
          )}
          <TabsTrigger value="mine">My requests</TabsTrigger>
          <TabsTrigger value="morning">Morning suggestions ({suggestions.length})</TabsTrigger>
          <TabsTrigger value="all">All active</TabsTrigger>
        </TabsList>
        {canManage && (
          <TabsContent value="queue">
            <RequestsTable
              rows={rows.filter((row) =>
                ["requested", "approved"].includes(row.replenishment_status),
              )}
              loading={loading}
              canManage
              onReview={(row, mode) => setReview({ row, mode })}
              onAction={(row, mode) => setAction({ row, mode })}
            />
          </TabsContent>
        )}
        <TabsContent value="mine">
          <RequestsTable
            rows={rows.filter((row) => row.requested_by === session.user?.id)}
            loading={loading}
            canManage={false}
            onAction={(row, mode) => setAction({ row, mode })}
          />
        </TabsContent>
        <TabsContent value="morning">
          <SuggestionsTable rows={suggestions} canPrepare={canManage} onDone={load} />
        </TabsContent>
        <TabsContent value="all">
          <RequestsTable
            rows={rows}
            loading={loading}
            canManage={canManage}
            onReview={(row, mode) => setReview({ row, mode })}
            onAction={(row, mode) => setAction({ row, mode })}
          />
        </TabsContent>
      </Tabs>

      {openNew && <RequestDialog onClose={() => setOpenNew(false)} onSaved={load} />}
      {review && (
        <ReviewRequestDialog
          requestId={review.row.id}
          itemName={review.row.inventory_items?.name ?? "—"}
          quantity={Number(review.row.quantity)}
          unit={review.row.inventory_items?.unit ?? ""}
          purpose={review.row.purpose}
          mode={review.mode}
          onClose={() => setReview(null)}
          onDone={load}
        />
      )}
      {action && (
        <MovementActionDialog
          row={action.row}
          mode={action.mode}
          onClose={() => setAction(null)}
          onDone={load}
        />
      )}
    </div>
  );
}

function RequestsTable({
  rows,
  loading,
  canManage,
  onReview,
  onAction,
}: {
  rows: RequestRow[];
  loading: boolean;
  canManage: boolean;
  onReview?: (row: RequestRow, mode: "approve" | "reject") => void;
  onAction: (row: RequestRow, mode: "issue" | "receive") => void;
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[800px] text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left">Requested</th>
            <th className="px-4 py-2 text-left">Shop</th>
            <th className="px-4 py-2 text-left">Item</th>
            <th className="px-4 py-2 text-left">Quantity</th>
            <th className="px-4 py-2 text-left">Reason</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading ? (
            <tr>
              <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                Loading…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                <ClipboardList className="mx-auto mb-2 size-8 opacity-40" />
                Nothing awaiting action.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id} className="align-top hover:bg-muted/30">
                <td className="px-4 py-3">
                  <p>{row.requester?.full_name ?? row.requester?.email ?? "—"}</p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(row.created_at), "d MMM · HH:mm")} · {row.request_kind}
                  </p>
                </td>
                <td className="px-4 py-3 font-medium">{row.shops?.name ?? "—"}</td>
                <td className="px-4 py-3">{row.inventory_items?.name ?? "—"}</td>
                <td className="px-4 py-3 font-mono">
                  {row.quantity} {row.inventory_items?.unit}
                  {row.approved_quantity !== null && row.approved_quantity !== row.quantity && (
                    <p className="text-xs text-blue-700">Approved {row.approved_quantity}</p>
                  )}
                </td>
                <td className="max-w-xs px-4 py-3 text-muted-foreground">{row.purpose}</td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className={STATUS[row.replenishment_status] ?? ""}>
                    {row.replenishment_status}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {canManage && row.replenishment_status === "requested" && onReview && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => onReview(row, "approve")}>
                        <Check className="mr-1 size-3 text-emerald-600" />
                        Approve
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onReview(row, "reject")}>
                        <X className="mr-1 size-3 text-red-600" />
                        Reject
                      </Button>
                    </>
                  )}
                  {canManage && row.replenishment_status === "approved" && (
                    <Button size="sm" onClick={() => onAction(row, "issue")}>
                      <Send className="mr-1 size-3" />
                      Issue dispatch
                    </Button>
                  )}
                  {row.replenishment_status === "dispatched" && (
                    <Button size="sm" variant="outline" onClick={() => onAction(row, "receive")}>
                      <PackageCheck className="mr-1 size-3" />
                      Confirm receipt
                    </Button>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function SuggestionsTable({
  rows,
  canPrepare,
  onDone,
}: {
  rows: Suggestion[];
  canPrepare: boolean;
  onDone: () => Promise<void>;
}) {
  const [preparing, setPreparing] = useState<string | null>(null);

  async function prepare(row: Suggestion) {
    setPreparing(row.id);
    const { error } = await (supabase as any).rpc("prepare_morning_replenishment", {
      _need_id: row.id,
      _client_reference_id: crypto.randomUUID(),
    });
    setPreparing(null);
    if (error) return toast.error(error.message);
    toast.success("Morning quantity is ready for Inventory to issue");
    await onDone();
  }

  return (
    <div className="mt-4 overflow-hidden rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left">Shop</th>
            <th className="px-4 py-2 text-left">Item</th>
            <th className="px-4 py-2 text-right">Approved closing</th>
            <th className="px-4 py-2 text-right">In transit</th>
            <th className="px-4 py-2 text-right">Suggested</th>
            <th className="px-4 py-2 text-left">Priority</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                No configured shop item is currently below reorder level.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 font-medium">{row.locations?.name ?? "—"}</td>
                <td className="px-4 py-3">
                  {row.inventory_items?.name ?? "—"}
                  <p className="font-mono text-xs text-muted-foreground">{row.need_number}</p>
                </td>
                <td className="px-4 py-3 text-right font-mono">{row.available_stock_snapshot}</td>
                <td className="px-4 py-3 text-right font-mono">{row.in_transit_snapshot}</td>
                <td className="px-4 py-3 text-right font-mono text-brand-orange">
                  +{row.suggested_quantity} {row.inventory_items?.unit}
                </td>
                <td className="px-4 py-3">
                  <Badge variant="outline">{row.priority}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  {canPrepare && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={preparing === row.id}
                      onClick={() => prepare(row)}
                    >
                      {preparing === row.id ? "Preparing…" : "Prepare morning issue"}
                    </Button>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function MovementActionDialog({
  row,
  mode,
  onClose,
  onDone,
}: {
  row: RequestRow;
  mode: "issue" | "receive";
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const expected = Number(row.approved_quantity ?? row.quantity);
  const [quantity, setQuantity] = useState(String(expected));
  const [notes, setNotes] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [saving, setSaving] = useState(false);
  const shopName = row.shops?.name ?? "the shop";
  async function submit() {
    if (mode === "receive" && Number(quantity) !== expected && !notes.trim())
      return toast.error("Explain any receipt mismatch");
    setSaving(true);
    const { error } =
      mode === "issue"
        ? await (supabase as any).rpc("issue_replenishment_request", {
            _request_id: row.id,
            _client_reference_id: crypto.randomUUID(),
            _vehicle: vehicle.trim() || null,
            _notes: notes.trim() || null,
          })
        : await (supabase as any).rpc("confirm_replenishment_receipt", {
            _request_id: row.id,
            _client_reference_id: crypto.randomUUID(),
            _received_quantity: Number(quantity),
            _notes: notes.trim() || null,
          });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(
      mode === "issue"
        ? `Dispatch issued; ${shopName} must confirm receipt`
        : Number(quantity) === expected
          ? "Receipt confirmed"
          : "Receipt recorded and discrepancy opened",
    );
    await onDone();
    onClose();
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "issue" ? "Issue replenishment dispatch" : `Confirm ${shopName} receipt`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md bg-muted p-3 text-sm">
            <p className="font-medium">{row.inventory_items?.name}</p>
            <p className="font-mono text-xs text-muted-foreground">
              Expected {expected} {row.inventory_items?.unit}
            </p>
          </div>
          {mode === "receive" && (
            <div>
              <Label>Quantity actually received</Label>
              <Input
                type="number"
                min="0"
                max={expected}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </div>
          )}
          {mode === "issue" && (
            <div>
              <Label>Vehicle / rider (optional)</Label>
              <Input value={vehicle} onChange={(event) => setVehicle(event.target.value)} />
            </div>
          )}
          <div>
            <Label>
              {mode === "receive" ? "Receipt or mismatch notes" : "Dispatch notes (optional)"}
            </Label>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : mode === "issue" ? "Issue dispatch" : "Confirm receipt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
