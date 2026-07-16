import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, ClipboardList, Check, X, PackageCheck } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { CAN_APPROVE_REQUESTS, hasAny } from "@/lib/permissions";
import { RequestDialog } from "@/components/requests/RequestDialog";
import { ReviewRequestDialog } from "@/components/requests/ReviewRequestDialog";
import { toast } from "sonner";
import { format } from "date-fns";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export const Route = createFileRoute("/_authenticated/requests")({
  component: RequestsPage,
});

interface RequestRow {
  id: string;
  quantity: number;
  purpose: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
  requested_by: string;
  fulfilled_movement_id: string | null;
  inventory_items: { name: string; unit: string } | null;
  shops: { name: string } | null;
  requester: { full_name: string | null; email: string } | null;
  reviewer: { full_name: string | null; email: string } | null;
}

const STATUS: Record<string, string> = {
  pending: "text-amber-700 border-amber-200 bg-amber-50",
  approved: "text-blue-700 border-blue-200 bg-blue-50",
  fulfilled: "text-emerald-700 border-emerald-200 bg-emerald-50",
  rejected: "text-red-700 border-red-200 bg-red-50",
  cancelled: "text-muted-foreground border-muted",
};

function RequestsPage() {
  const session = useSession();
  const canApprove = hasAny(session.roles, CAN_APPROVE_REQUESTS);
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openNew, setOpenNew] = useState(false);
  const [review, setReview] = useState<{ row: RequestRow; mode: "approve" | "reject" } | null>(null);
  const [tab, setTab] = useState(canApprove ? "pending" : "mine");

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("stock_requests")
      .select(
        "id, quantity, purpose, status, created_at, reviewed_at, review_notes, requested_by, fulfilled_movement_id, inventory_items(name, unit), shops(name), requester:profiles!stock_requests_requested_by_fkey(full_name, email), reviewer:profiles!stock_requests_reviewer_id_fkey(full_name, email)",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) toast.error(error.message);
    setRows((data as unknown as RequestRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const pending = rows.filter((r) => r.status === "pending");
  const mine = rows.filter((r) => r.requested_by === session.user?.id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stock requests</h1>
          <p className="text-sm text-muted-foreground">Request stock from inventory. Approvals issue stock automatically and notify the requester.</p>
        </div>
        <Button onClick={() => setOpenNew(true)} className="bg-brand-orange text-white hover:bg-brand-orange/90">
          <Plus className="size-4 mr-2" /> Request stock
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {canApprove && <TabsTrigger value="pending">Pending ({pending.length})</TabsTrigger>}
          <TabsTrigger value="mine">My requests ({mine.length})</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
        {canApprove && (
          <TabsContent value="pending">
            <Table rows={pending} loading={loading} canApprove onReview={(row, mode) => setReview({ row, mode })} />
          </TabsContent>
        )}
        <TabsContent value="mine"><Table rows={mine} loading={loading} canApprove={false} /></TabsContent>
        <TabsContent value="all">
          <Table rows={rows} loading={loading} canApprove={canApprove} onReview={(row, mode) => setReview({ row, mode })} />
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
    </div>
  );
}

function Table({
  rows,
  loading,
  canApprove,
  onReview,
}: {
  rows: RequestRow[];
  loading: boolean;
  canApprove: boolean;
  onReview?: (row: RequestRow, mode: "approve" | "reject") => void;
}) {
  return (
    <div className="rounded-lg border overflow-hidden bg-card mt-4">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground tracking-wider">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Requester</th>
            <th className="text-left px-4 py-2 font-medium">Item</th>
            <th className="text-left px-4 py-2 font-medium">Qty</th>
            <th className="text-left px-4 py-2 font-medium">Purpose</th>
            <th className="text-left px-4 py-2 font-medium">Shop</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
            <th className="text-left px-4 py-2 font-medium">Reviewed</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading ? (
            <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                <ClipboardList className="mx-auto size-8 mb-2 opacity-50" />
                No requests.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id} className="hover:bg-muted/30 align-top">
                <td className="px-4 py-3">
                  <div>{r.requester?.full_name ?? r.requester?.email ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">{format(new Date(r.created_at), "d MMM · HH:mm")}</div>
                </td>
                <td className="px-4 py-3">{r.inventory_items?.name ?? "—"}</td>
                <td className="px-4 py-3 font-mono whitespace-nowrap">{Number(r.quantity)} {r.inventory_items?.unit ?? ""}</td>
                <td className="px-4 py-3 text-muted-foreground max-w-xs truncate" title={r.purpose}>{r.purpose}</td>
                <td className="px-4 py-3 text-muted-foreground">{r.shops?.name ?? "—"}</td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className={STATUS[r.status] ?? ""}>{r.status}</Badge>
                  {r.status === "fulfilled" && r.fulfilled_movement_id && (
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-700">
                      <PackageCheck className="size-3" /> Stock issued
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {r.reviewed_at ? (
                    <>
                      <div>{format(new Date(r.reviewed_at), "d MMM · HH:mm")}</div>
                      <div>{r.reviewer?.full_name ?? r.reviewer?.email ?? ""}</div>
                      {r.review_notes && <div className="italic mt-1 max-w-[14rem] truncate" title={r.review_notes}>“{r.review_notes}”</div>}
                    </>
                  ) : "—"}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {canApprove && r.status === "pending" && onReview && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => onReview(r, "approve")}>
                        <Check className="size-3 mr-1 text-emerald-600" /> Approve
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onReview(r, "reject")}>
                        <X className="size-3 mr-1 text-red-600" /> Reject
                      </Button>
                    </>
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
