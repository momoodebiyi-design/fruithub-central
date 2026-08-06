/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  FileText,
  PackageCheck,
  Plus,
  ShoppingCart,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import {
  CAN_APPROVE_PURCHASES,
  CAN_MANAGE_PURCHASES,
  CAN_RECEIVE_PURCHASES,
  CAN_REVIEW_PURCHASE_NEEDS,
  hasAny,
} from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/_authenticated/purchasing")({ component: PurchasingPage });

type Need = {
  id: string;
  need_number: string;
  item_id: string;
  location_id: string;
  source: string;
  available_stock_snapshot: number;
  suggested_quantity: number;
  requested_quantity: number;
  required_date: string | null;
  priority: string;
  reason: string | null;
  status: string;
  stock_recovered_at: string | null;
  created_at: string;
  inventory_items: { name: string; unit: string; sku: string | null } | null;
  locations: { name: string } | null;
};

type Order = {
  id: string;
  po_number: string;
  supplier_id: string | null;
  expected_date: string | null;
  workflow_status: string;
  quoted_total: number;
  quotation_reference: string | null;
  quotation_evidence_path: string | null;
  payment_reference: string | null;
  payment_evidence_path: string | null;
  created_at: string;
  created_by: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  payment_recorded_at: string | null;
  delivered_at: string | null;
  suppliers: { name: string } | null;
};

type Supplier = { id: string; name: string };
type OrderLine = {
  id: string;
  item_id: string;
  quantity_ordered: number;
  quantity_delivered: number;
  quantity_accepted: number;
  quantity_rejected: number;
  quantity_received: number;
  unit_cost: number;
  inventory_items: { name: string; unit: string } | null;
  locations: { name: string } | null;
};
type Receipt = {
  id: string;
  receipt_number: string;
  status: string;
  delivery_evidence_path: string;
  purchase_receipt_lines: Array<{
    id: string;
    quantity_delivered: number;
    purchase_order_items: { inventory_items: { name: string; unit: string } | null } | null;
  }>;
};

type OrderAction = "details" | "submit" | "approve" | "reject" | "payment" | "delivery" | "receive";

const ORDER_COLORS: Record<string, string> = {
  awaiting_approval: "border-amber-200 bg-amber-50 text-amber-700",
  approved: "border-blue-200 bg-blue-50 text-blue-700",
  being_purchased: "border-violet-200 bg-violet-50 text-violet-700",
  delivered: "border-orange-200 bg-orange-50 text-orange-700",
  received: "border-emerald-200 bg-emerald-50 text-emerald-700",
  partially_received: "border-red-200 bg-red-50 text-red-700",
  rejected: "border-red-200 bg-red-50 text-red-700",
};

const ORDER_STATUS: Record<string, { label: string; owner: string; next: string }> = {
  draft: {
    label: "Quoted draft",
    owner: "Procurement",
    next: "Submit for MD approval",
  },
  awaiting_approval: {
    label: "Awaiting approval",
    owner: "MD / authorised approver",
    next: "Review supplier, quantities and cost",
  },
  approved: {
    label: "Approved",
    owner: "Procurement",
    next: "Place order and record payment",
  },
  being_purchased: {
    label: "Ordered / awaiting delivery",
    owner: "Procurement",
    next: "Record the supplier delivery",
  },
  delivered: {
    label: "Awaiting inspection",
    owner: "Inventory",
    next: "Inspect and accept or reject delivery",
  },
  partially_received: {
    label: "Partially received",
    owner: "Procurement",
    next: "Follow up and record the outstanding delivery",
  },
  received: {
    label: "Received",
    owner: "Complete",
    next: "Accepted quantities are in Central Inventory",
  },
  rejected: {
    label: "Rejected",
    owner: "Procurement",
    next: "Needs have returned to the sourcing queue",
  },
  cancelled: {
    label: "Cancelled",
    owner: "Complete",
    next: "No further action",
  },
};

function PurchasingPage() {
  const session = useSession();
  const canReviewNeeds = hasAny(session.roles, CAN_REVIEW_PURCHASE_NEEDS);
  const canSource = hasAny(session.roles, CAN_MANAGE_PURCHASES);
  const canApprove =
    hasAny(session.roles, CAN_APPROVE_PURCHASES) && !session.roles.includes("procurement");
  const canReceive = hasAny(session.roles, CAN_RECEIVE_PURCHASES);
  const [needs, setNeeds] = useState<Need[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [procurementConfigured, setProcurementConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [reviewNeed, setReviewNeed] = useState<Need | null>(null);
  const [manualNeed, setManualNeed] = useState(false);
  const [newOrder, setNewOrder] = useState(false);
  const [orderAction, setOrderAction] = useState<{
    order: Order;
    action: OrderAction;
  } | null>(null);

  async function load() {
    setLoading(true);
    const [
      { data: needRows, error: needError },
      { data: orderRows, error: orderError },
      { data: supplierRows },
      { data: procurementRows },
    ] = await Promise.all([
      (supabase as any)
        .from("purchase_needs")
        .select(
          "id, need_number, item_id, location_id, source, available_stock_snapshot, suggested_quantity, requested_quantity, required_date, priority, reason, status, stock_recovered_at, created_at, inventory_items(name, unit, sku), locations:locations!purchase_needs_location_id_fkey(name)",
        )
        .eq("source_type", "purchasing")
        .in("status", ["draft", "ready", "sourcing", "ordered"])
        .order("created_at", { ascending: false }),
      (supabase as any)
        .from("purchase_orders")
        .select(
          "id, po_number, supplier_id, expected_date, workflow_status, quoted_total, quotation_reference, quotation_evidence_path, payment_reference, payment_evidence_path, created_at, created_by, submitted_by, submitted_at, approved_by, approved_at, payment_recorded_at, delivered_at, suppliers(name)",
        )
        .order("created_at", { ascending: false })
        .limit(150),
      supabase.from("suppliers").select("id, name").order("name"),
      supabase.from("user_roles").select("user_id").eq("role", "procurement").limit(1),
    ]);
    if (needError) toast.error(needError.message);
    if (orderError) toast.error(orderError.message);
    setNeeds((needRows as Need[]) ?? []);
    setOrders((orderRows as Order[]) ?? []);
    setSuppliers((supplierRows as Supplier[]) ?? []);
    setProcurementConfigured(Boolean(procurementRows?.length));
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);
  const readyNeeds = useMemo(() => needs.filter((need) => need.status === "ready"), [needs]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Purchasing</h1>
          <p className="text-sm text-muted-foreground">
            External sourcing from stock need through independent receipt.
          </p>
        </div>
        <div className="flex gap-2">
          {canReviewNeeds && (
            <Button variant="outline" onClick={() => setManualNeed(true)}>
              <Plus className="mr-2 size-4" />
              Manual need
            </Button>
          )}
          {canSource && (
            <Button
              onClick={() => setNewOrder(true)}
              disabled={readyNeeds.length === 0 || suppliers.length === 0}
              className="bg-brand-orange text-white hover:bg-brand-orange/90"
            >
              <Plus className="mr-2 size-4" />
              Create quoted order
            </Button>
          )}
        </div>
      </div>

      {suppliers.length === 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mr-2 inline size-4" />
          Configure at least one supplier before submitting a real order.
        </div>
      )}

      {!procurementConfigured && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mr-2 inline size-4" />
          No Procurement user is assigned. Give the Logistics or Procurement staff member the
          Procurement role in Users so one person can submit and another can approve.
        </div>
      )}

      <Tabs defaultValue="needs">
        <TabsList>
          <TabsTrigger value="needs">Needs ({needs.length})</TabsTrigger>
          <TabsTrigger value="orders">Orders ({orders.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="needs">
          <NeedsTable
            needs={needs}
            loading={loading}
            canReview={canReviewNeeds}
            onReview={setReviewNeed}
          />
        </TabsContent>
        <TabsContent value="orders">
          <OrdersTable
            orders={orders}
            loading={loading}
            canSource={canSource}
            canApprove={canApprove}
            canReceive={canReceive}
            currentUserId={session.user?.id ?? null}
            onAction={(order, action) => setOrderAction({ order, action })}
          />
        </TabsContent>
      </Tabs>

      {reviewNeed && (
        <ReviewNeedDialog need={reviewNeed} onClose={() => setReviewNeed(null)} onDone={load} />
      )}
      {manualNeed && <ManualNeedDialog onClose={() => setManualNeed(false)} onDone={load} />}
      {newOrder && (
        <QuotedOrderDialog
          needs={readyNeeds}
          suppliers={suppliers}
          onClose={() => setNewOrder(false)}
          onDone={load}
        />
      )}
      {orderAction && (
        <OrderActionDialog
          order={orderAction.order}
          action={orderAction.action}
          onClose={() => setOrderAction(null)}
          onDone={load}
        />
      )}
    </div>
  );
}

function ManualNeedDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [items, setItems] = useState<Array<{ id: string; name: string; unit: string }>>([]);
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [itemId, setItemId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [date, setDate] = useState("");
  const [priority, setPriority] = useState("normal");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [{ data: itemRows }, { data: locationRows }] = await Promise.all([
        supabase
          .from("inventory_items")
          .select("id, name, unit")
          .eq("status", "active")
          .in("category", ["raw_material", "packaging", "consumable"])
          .order("name"),
        supabase.from("locations").select("id, name").eq("status", "active").order("name"),
      ]);
      setItems((itemRows as typeof items) ?? []);
      setLocations((locationRows as typeof locations) ?? []);
      const central = (locationRows as typeof locations | null)?.find(
        (location) => location.name === "Main Store",
      );
      if (central) setLocationId(central.id);
    })();
  }, []);

  async function save() {
    setSaving(true);
    const { error } = await (supabase as any).rpc("create_manual_purchase_need", {
      _client_reference_id: crypto.randomUUID(),
      _item_id: itemId,
      _location_id: locationId,
      _quantity: Number(quantity),
      _required_date: date || null,
      _priority: priority,
      _reason: reason.trim(),
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Manual need authorised and ready for Procurement");
    await onDone();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Authorise manual purchase need</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Item</Label>
            <Select value={itemId} onValueChange={setItemId}>
              <SelectTrigger>
                <SelectValue placeholder="Select item" />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} · {item.unit}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Receiving location</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger>
                <SelectValue placeholder="Select location" />
              </SelectTrigger>
              <SelectContent>
                {locations.map((location) => (
                  <SelectItem key={location.id} value={location.id}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Quantity</Label>
              <Input
                type="number"
                min="0.001"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </div>
            <div>
              <Label>Required date</Label>
              <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </div>
          </div>
          <div>
            <Label>Priority</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Business reason</Label>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving || !itemId || !locationId || Number(quantity) <= 0 || !reason.trim()}
          >
            {saving ? "Saving…" : "Authorise need"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NeedsTable({
  needs,
  loading,
  canReview,
  onReview,
}: {
  needs: Need[];
  loading: boolean;
  canReview: boolean;
  onReview: (need: Need) => void;
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[850px] text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left">Need</th>
            <th className="px-4 py-2 text-left">Item / location</th>
            <th className="px-4 py-2 text-right">Available</th>
            <th className="px-4 py-2 text-right">Suggested / requested</th>
            <th className="px-4 py-2 text-left">Priority</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading ? (
            <tr>
              <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                Loading…
              </td>
            </tr>
          ) : needs.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                <ShoppingCart className="mx-auto mb-2 size-8 opacity-40" />
                No configured item is below its reorder level.
              </td>
            </tr>
          ) : (
            needs.map((need) => (
              <tr key={need.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-mono text-xs">
                  {need.need_number}
                  <p className="mt-1 font-sans text-muted-foreground">
                    {format(new Date(need.created_at), "d MMM, HH:mm")}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <p>{need.inventory_items?.name ?? "—"}</p>
                  <p className="text-xs text-muted-foreground">
                    {need.locations?.name ?? "—"} · {need.inventory_items?.sku ?? ""}
                  </p>
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {need.available_stock_snapshot} {need.inventory_items?.unit}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  <p>{need.suggested_quantity}</p>
                  <p className="text-brand-orange">{need.requested_quantity}</p>
                </td>
                <td className="px-4 py-3">
                  <Badge
                    variant="outline"
                    className={
                      need.priority === "critical" ? "border-red-200 bg-red-50 text-red-700" : ""
                    }
                  >
                    {need.priority}
                  </Badge>
                  {need.stock_recovered_at && (
                    <p className="mt-1 text-xs text-amber-700">
                      Stock recovered; verify before continuing
                    </p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <Badge variant="outline">{need.status}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  {canReview && need.status === "draft" && (
                    <Button size="sm" variant="outline" onClick={() => onReview(need)}>
                      <ClipboardCheck className="mr-1 size-3" />
                      Review
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

function OrdersTable({
  orders,
  loading,
  canSource,
  canApprove,
  canReceive,
  currentUserId,
  onAction,
}: {
  orders: Order[];
  loading: boolean;
  canSource: boolean;
  canApprove: boolean;
  canReceive: boolean;
  currentUserId: string | null;
  onAction: (order: Order, action: OrderAction) => void;
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left">Order</th>
            <th className="px-4 py-2 text-left">Supplier</th>
            <th className="px-4 py-2 text-left">Quote</th>
            <th className="px-4 py-2 text-right">Total</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-left">Next owner</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading ? (
            <tr>
              <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                Loading…
              </td>
            </tr>
          ) : orders.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                No purchase orders yet.
              </td>
            </tr>
          ) : (
            orders.map((order) => {
              const status = ORDER_STATUS[order.workflow_status] ?? {
                label: order.workflow_status.replaceAll("_", " "),
                owner: "—",
                next: "—",
              };
              const submittedByCurrentUser =
                Boolean(currentUserId) && order.submitted_by === currentUserId;
              return (
                <tr key={order.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <p className="font-mono">{order.po_number}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(order.created_at), "d MMM yyyy")}
                    </p>
                  </td>
                  <td className="px-4 py-3">{order.suppliers?.name ?? "—"}</td>
                  <td className="px-4 py-3">{order.quotation_reference ?? "—"}</td>
                  <td className="px-4 py-3 text-right font-mono">
                    ₦{Number(order.quoted_total).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={ORDER_COLORS[order.workflow_status] ?? ""}>
                      {status.label}
                    </Badge>
                  </td>
                  <td className="max-w-[220px] px-4 py-3">
                    <p className="text-sm font-medium">{status.owner}</p>
                    <p className="text-xs text-muted-foreground">{status.next}</p>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => onAction(order, "details")}>
                      View
                    </Button>
                    {canSource && order.workflow_status === "draft" && (
                      <Button size="sm" onClick={() => onAction(order, "submit")}>
                        Submit for approval
                      </Button>
                    )}
                    {canApprove &&
                      order.workflow_status === "awaiting_approval" &&
                      !submittedByCurrentUser && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onAction(order, "approve")}
                          >
                            <Check className="mr-1 size-3 text-emerald-600" />
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onAction(order, "reject")}
                          >
                            <X className="mr-1 size-3 text-red-600" />
                            Reject
                          </Button>
                        </>
                      )}
                    {canApprove &&
                      order.workflow_status === "awaiting_approval" &&
                      submittedByCurrentUser && (
                        <p className="mt-1 text-xs text-amber-700">
                          You submitted this order. Another approver must decide it.
                        </p>
                      )}
                    {canSource && order.workflow_status === "approved" && (
                      <Button size="sm" onClick={() => onAction(order, "payment")}>
                        <FileText className="mr-1 size-3" />
                        Place order
                      </Button>
                    )}
                    {canSource &&
                      ["being_purchased", "partially_received"].includes(order.workflow_status) && (
                        <Button size="sm" onClick={() => onAction(order, "delivery")}>
                          <ShoppingCart className="mr-1 size-3" />
                          Record delivery
                        </Button>
                      )}
                    {canReceive && order.workflow_status === "delivered" && (
                      <Button size="sm" onClick={() => onAction(order, "receive")}>
                        <PackageCheck className="mr-1 size-3" />
                        Inspect & receive
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function ReviewNeedDialog({
  need,
  onClose,
  onDone,
}: {
  need: Need;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(String(need.requested_quantity));
  const [date, setDate] = useState(need.required_date ?? "");
  const [priority, setPriority] = useState(need.priority);
  const [reason, setReason] = useState(need.reason ?? "Low stock at configured location");
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    const { error } = await (supabase as any).rpc("mark_purchase_need_ready", {
      _need_id: need.id,
      _quantity: Number(quantity),
      _required_date: date || null,
      _priority: priority,
      _reason: reason.trim(),
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Need marked ready for Procurement");
    await onDone();
    onClose();
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Review purchase need</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md bg-muted p-3 text-sm">
            <p className="font-medium">{need.inventory_items?.name}</p>
            <p className="text-xs text-muted-foreground">
              Available {need.available_stock_snapshot}; suggested {need.suggested_quantity}{" "}
              {need.inventory_items?.unit}
            </p>
          </div>
          <div>
            <Label>Requested quantity</Label>
            <Input
              type="number"
              min="0.001"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </div>
          <div>
            <Label>Required date</Label>
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
          <div>
            <Label>Priority</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Reason</Label>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Ready for sourcing"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function uploadEvidence(file: File | null, folder: string) {
  if (!file) return "";
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const path = `${folder}/${crypto.randomUUID()}-${safe}`;
  const { error } = await supabase.storage
    .from("purchase-evidence")
    .upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

async function openEvidence(path: string) {
  const { data, error } = await supabase.storage
    .from("purchase-evidence")
    .createSignedUrl(path, 60);
  if (error || !data?.signedUrl) {
    toast.error(error?.message ?? "Could not open evidence");
    return;
  }
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}

function QuotedOrderDialog({
  needs,
  suppliers,
  onClose,
  onDone,
}: {
  needs: Need[];
  suppliers: Supplier[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [supplierId, setSupplierId] = useState("");
  const [expected, setExpected] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<Record<string, { quantity: string; cost: string }>>({});
  const [saving, setSaving] = useState(false);
  function toggle(need: Need, checked: boolean) {
    setSelected((current) => {
      const next = { ...current };
      if (checked) next[need.id] = { quantity: String(need.requested_quantity), cost: "" };
      else delete next[need.id];
      return next;
    });
  }
  async function save() {
    const lines = Object.entries(selected).map(([need_id, values]) => ({
      need_id,
      quantity: Number(values.quantity),
      unit_cost: Number(values.cost),
    }));
    if (
      !supplierId ||
      !reference.trim() ||
      lines.length === 0 ||
      lines.some((line) => line.quantity <= 0 || line.unit_cost < 0)
    )
      return toast.error(
        "Supplier, quote reference, selected needs, quantities and costs are required",
      );
    setSaving(true);
    try {
      const evidence = await uploadEvidence(file, "quotes");
      const { error } = await (supabase as any).rpc("create_quoted_purchase_order", {
        _client_reference_id: crypto.randomUUID(),
        _supplier_id: supplierId,
        _expected_date: expected || null,
        _quotation_reference: reference.trim(),
        _quotation_evidence_path: evidence || null,
        _notes: notes.trim() || null,
        _lines: lines,
      });
      if (error) throw error;
      toast.success("Quoted order created as a draft");
      await onDone();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create order");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create quoted purchase order</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Supplier</Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose supplier" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((supplier) => (
                    <SelectItem key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Expected date</Label>
              <Input
                type="date"
                value={expected}
                onChange={(event) => setExpected(event.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>Quotation reference</Label>
            <Input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Supplier quote number or description"
            />
          </div>
          <div>
            <Label>Quotation evidence (where available)</Label>
            <Input
              type="file"
              accept="image/*,.pdf"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-2">
            <Label>Ready needs</Label>
            {needs.map((need) => {
              const values = selected[need.id];
              return (
                <div key={need.id} className="rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={Boolean(values)}
                      onCheckedChange={(checked) => toggle(need, checked === true)}
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{need.inventory_items?.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {need.need_number} · requested {need.requested_quantity}{" "}
                        {need.inventory_items?.unit}
                      </p>
                    </div>
                  </div>
                  {values && (
                    <div className="mt-3 grid grid-cols-2 gap-3 pl-6">
                      <div>
                        <Label>Quoted quantity</Label>
                        <Input
                          type="number"
                          value={values.quantity}
                          onChange={(event) =>
                            setSelected((current) => ({
                              ...current,
                              [need.id]: { ...current[need.id], quantity: event.target.value },
                            }))
                          }
                        />
                      </div>
                      <div>
                        <Label>Unit cost (₦)</Label>
                        <Input
                          type="number"
                          min="0"
                          value={values.cost}
                          onChange={(event) =>
                            setSelected((current) => ({
                              ...current,
                              [need.id]: { ...current[need.id], cost: event.target.value },
                            }))
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div>
            <Label>Notes (optional)</Label>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Create quoted draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OrderActionDialog({
  order,
  action,
  onClose,
  onDone,
}: {
  order: Order;
  action: OrderAction;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [quantities, setQuantities] = useState<
    Record<string, { delivered?: string; accepted?: string; rejected?: string; notes?: string }>
  >({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    (async () => {
      const { data } = await (supabase as any)
        .from("purchase_order_items")
        .select(
          "id, item_id, quantity_ordered, quantity_delivered, quantity_accepted, quantity_rejected, quantity_received, unit_cost, inventory_items(name, unit), locations(name)",
        )
        .eq("purchase_order_id", order.id);
      const orderLines = (data as OrderLine[]) ?? [];
      setLines(orderLines);
      if (action === "delivery")
        setQuantities(
          Object.fromEntries(
            orderLines.map((line) => [
              line.id,
              {
                delivered: String(
                  Math.max(0, Number(line.quantity_ordered) - Number(line.quantity_delivered)),
                ),
              },
            ]),
          ),
        );
      if (action === "receive") {
        const { data: receipts } = await (supabase as any)
          .from("purchase_receipts")
          .select(
            "id, receipt_number, status, delivery_evidence_path, purchase_receipt_lines(id, quantity_delivered, purchase_order_items(inventory_items(name, unit)))",
          )
          .eq("purchase_order_id", order.id)
          .eq("status", "awaiting_inspection")
          .order("recorded_at", { ascending: false })
          .limit(1);
        const current = (receipts as Receipt[] | null)?.[0] ?? null;
        setReceipt(current);
        if (current)
          setQuantities(
            Object.fromEntries(
              current.purchase_receipt_lines.map((line) => [
                line.id,
                { accepted: String(line.quantity_delivered), rejected: "0", notes: "" },
              ]),
            ),
          );
      }
    })();
  }, [action, order.id]);
  const deliveredNowTotal = lines.reduce(
    (total, line) => total + Number(quantities[line.id]?.delivered ?? 0),
    0,
  );
  const receiptQuantitiesValid =
    !receipt ||
    receipt.purchase_receipt_lines.every((line) => {
      const accepted = Number(quantities[line.id]?.accepted ?? 0);
      const rejected = Number(quantities[line.id]?.rejected ?? 0);
      return (
        accepted >= 0 && rejected >= 0 && accepted + rejected === Number(line.quantity_delivered)
      );
    });
  async function submit() {
    if (action === "details") return;
    setSaving(true);
    try {
      let error: { message: string } | null = null;
      if (action === "submit")
        ({ error } = await (supabase as any).rpc("submit_quoted_purchase_order", {
          _purchase_order_id: order.id,
        }));
      if (action === "approve" || action === "reject")
        ({ error } = await (supabase as any).rpc("decide_purchase_order", {
          _purchase_order_id: order.id,
          _approve: action === "approve",
          _reason: notes.trim() || null,
        }));
      if (action === "payment") {
        const path = await uploadEvidence(file, "payments");
        ({ error } = await (supabase as any).rpc("record_purchase_payment", {
          _purchase_order_id: order.id,
          _payment_reference: reference.trim(),
          _payment_evidence_path: path,
        }));
      }
      if (action === "delivery") {
        const path = await uploadEvidence(file, "deliveries");
        ({ error } = await (supabase as any).rpc("record_purchase_delivery", {
          _purchase_order_id: order.id,
          _client_reference_id: crypto.randomUUID(),
          _delivery_evidence_path: path,
          _notes: notes.trim() || null,
          _lines: lines.map((line) => ({
            line_id: line.id,
            delivered: Number(quantities[line.id]?.delivered ?? 0),
          })),
        }));
      }
      if (action === "receive") {
        if (!receipt) throw new Error("No delivery is awaiting inspection");
        ({ error } = await (supabase as any).rpc("inspect_purchase_receipt", {
          _purchase_receipt_id: receipt.id,
          _client_reference_id: crypto.randomUUID(),
          _quality_notes: notes.trim() || null,
          _lines: receipt.purchase_receipt_lines.map((line) => ({
            receipt_line_id: line.id,
            accepted: Number(quantities[line.id]?.accepted ?? 0),
            rejected: Number(quantities[line.id]?.rejected ?? 0),
            notes: quantities[line.id]?.notes ?? "",
          })),
        }));
      }
      if (error) throw new Error(error.message);
      toast.success(
        action === "submit"
          ? "Submitted for MD approval"
          : action === "approve"
            ? "Purchase approved; Procurement may now place the order"
            : action === "reject"
              ? "Purchase rejected"
              : action === "payment"
                ? "Order placed; outstanding quantities now appear as Incoming"
                : action === "delivery"
                  ? "Delivery recorded; Inventory must inspect it"
                  : `Inspection complete; ${
                      receipt?.purchase_receipt_lines.reduce(
                        (total, line) => total + Number(quantities[line.id]?.accepted ?? 0),
                        0,
                      ) ?? 0
                    } accepted units were added to Central Inventory`,
      );
      await onDone();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
    } finally {
      setSaving(false);
    }
  }
  const title = {
    details: "Purchase order details",
    submit: "Submit quoted order",
    approve: "Approve purchase",
    reject: "Reject purchase",
    payment: "Place order and record payment",
    delivery: "Record supplier delivery",
    receive: "Inspect and receive",
  }[action];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md bg-muted p-3 text-sm">
            <p className="font-mono font-medium">{order.po_number}</p>
            <p className="text-muted-foreground">
              {order.suppliers?.name} · ₦{Number(order.quoted_total).toLocaleString()}
            </p>
          </div>
          <OrderJourney status={order.workflow_status} />
          {!["delivery", "receive"].includes(action) && <OrderLinesSummary lines={lines} />}
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">Quote: {order.quotation_reference ?? "—"}</Badge>
            {order.expected_date && (
              <Badge variant="outline">
                Expected {format(new Date(`${order.expected_date}T00:00:00`), "d MMM yyyy")}
              </Badge>
            )}
            {order.quotation_evidence_path && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openEvidence(order.quotation_evidence_path!)}
              >
                <FileText className="mr-1 size-3" /> View quotation evidence
              </Button>
            )}
            {order.payment_evidence_path && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openEvidence(order.payment_evidence_path!)}
              >
                <FileText className="mr-1 size-3" /> View payment evidence
              </Button>
            )}
          </div>
          {action === "details" && (
            <div className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-2">
              <TimelineRow label="Created" value={order.created_at} />
              <TimelineRow label="Submitted" value={order.submitted_at} />
              <TimelineRow label="Approved" value={order.approved_at} />
              <TimelineRow label="Order placed" value={order.payment_recorded_at} />
              <TimelineRow label="Delivery recorded" value={order.delivered_at} />
            </div>
          )}
          {action === "submit" && (
            <p className="text-sm text-muted-foreground">
              Every order requires MD approval while the monetary threshold is unset.
            </p>
          )}
          {action === "reject" && (
            <div>
              <Label>Rejection reason</Label>
              <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
            </div>
          )}
          {action === "payment" && (
            <>
              <div>
                <Label>Payment transfer reference</Label>
                <Input value={reference} onChange={(event) => setReference(event.target.value)} />
              </div>
              <div>
                <Label>Mandatory invoice / receipt</Label>
                <Input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </div>
            </>
          )}
          {action === "delivery" && (
            <>
              <div>
                <Label>Mandatory delivery evidence</Label>
                <Input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </div>
              {lines.map((line) => (
                <div
                  key={line.id}
                  className="grid grid-cols-[1fr_140px] items-end gap-3 rounded-md border p-3"
                >
                  <div>
                    <p className="text-sm font-medium">{line.inventory_items?.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Ordered {line.quantity_ordered}; previously delivered{" "}
                      {line.quantity_delivered}
                    </p>
                  </div>
                  <div>
                    <Label>Delivered now</Label>
                    <Input
                      type="number"
                      min="0"
                      value={quantities[line.id]?.delivered ?? "0"}
                      onChange={(event) =>
                        setQuantities((current) => ({
                          ...current,
                          [line.id]: { ...current[line.id], delivered: event.target.value },
                        }))
                      }
                    />
                  </div>
                </div>
              ))}
              <div>
                <Label>Delivery notes</Label>
                <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
              </div>
            </>
          )}
          {action === "receive" && (
            <>
              {!receipt ? (
                <p className="text-sm text-muted-foreground">Loading delivery…</p>
              ) : (
                <>
                  <div className="flex items-center justify-between rounded-md border bg-muted/30 p-3">
                    <div>
                      <p className="text-sm font-medium">{receipt.receipt_number}</p>
                      <p className="text-xs text-muted-foreground">
                        Delivery evidence must be checked before acceptance.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openEvidence(receipt.delivery_evidence_path)}
                    >
                      <FileText className="mr-1 size-3" /> View delivery evidence
                    </Button>
                  </div>
                  {receipt.purchase_receipt_lines.map((line) => (
                    <div key={line.id} className="rounded-md border p-3">
                      <p className="text-sm font-medium">
                        {line.purchase_order_items?.inventory_items?.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Delivered {line.quantity_delivered}{" "}
                        {line.purchase_order_items?.inventory_items?.unit}
                      </p>
                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <div>
                          <Label>Accepted</Label>
                          <Input
                            type="number"
                            min="0"
                            value={quantities[line.id]?.accepted ?? ""}
                            onChange={(event) =>
                              setQuantities((current) => ({
                                ...current,
                                [line.id]: { ...current[line.id], accepted: event.target.value },
                              }))
                            }
                          />
                        </div>
                        <div>
                          <Label>Rejected</Label>
                          <Input
                            type="number"
                            min="0"
                            value={quantities[line.id]?.rejected ?? ""}
                            onChange={(event) =>
                              setQuantities((current) => ({
                                ...current,
                                [line.id]: { ...current[line.id], rejected: event.target.value },
                              }))
                            }
                          />
                        </div>
                      </div>
                      <div className="mt-3">
                        <Label>Quality notes</Label>
                        <Input
                          value={quantities[line.id]?.notes ?? ""}
                          onChange={(event) =>
                            setQuantities((current) => ({
                              ...current,
                              [line.id]: { ...current[line.id], notes: event.target.value },
                            }))
                          }
                        />
                      </div>
                    </div>
                  ))}
                </>
              )}
              <div>
                <Label>Overall quality notes</Label>
                <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          {action === "details" ? (
            <Button onClick={onClose}>Close</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={
                  saving ||
                  (action === "reject" && !notes.trim()) ||
                  (action === "payment" && (!reference.trim() || !file)) ||
                  (action === "delivery" && (!file || deliveredNowTotal <= 0)) ||
                  (action === "receive" && (!receipt || !receiptQuantitiesValid))
                }
                className={action === "reject" ? "bg-red-600 text-white hover:bg-red-700" : ""}
              >
                {saving ? "Saving…" : title}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OrderJourney({ status }: { status: string }) {
  const steps = [
    ["draft", "Quoted"],
    ["awaiting_approval", "Approval"],
    ["approved", "Approved"],
    ["being_purchased", "Ordered"],
    ["delivered", "Delivered"],
    ["received", "Received"],
  ];
  const rank: Record<string, number> = {
    draft: 0,
    awaiting_approval: 1,
    approved: 2,
    being_purchased: 3,
    delivered: 4,
    partially_received: 4,
    received: 5,
  };
  const current = rank[status] ?? -1;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-1 text-[10px] text-muted-foreground">
        {steps.map(([key, label], index) => (
          <div key={key} className="flex min-w-0 flex-1 items-center last:flex-none">
            <span
              className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                index <= current
                  ? "border-brand-green bg-brand-green text-white"
                  : "border-muted-foreground/30 bg-background"
              }`}
            >
              {index < current ? "✓" : index + 1}
            </span>
            {index < steps.length - 1 && (
              <span
                className={`mx-1 h-px flex-1 ${index < current ? "bg-brand-green" : "bg-border"}`}
              />
            )}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-6 text-center text-[10px] text-muted-foreground">
        {steps.map(([key, label]) => (
          <span key={key}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function OrderLinesSummary({ lines }: { lines: OrderLine[] }) {
  if (lines.length === 0)
    return <p className="text-sm text-muted-foreground">Loading order items…</p>;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">Item</th>
            <th className="px-3 py-2 text-right">Ordered</th>
            <th className="px-3 py-2 text-right">Unit cost</th>
            <th className="px-3 py-2 text-right">Accepted</th>
            <th className="px-3 py-2 text-right">Outstanding</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {lines.map((line) => (
            <tr key={line.id}>
              <td className="px-3 py-2">
                <p>{line.inventory_items?.name ?? "—"}</p>
                <p className="text-xs text-muted-foreground">{line.locations?.name ?? "—"}</p>
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {Number(line.quantity_ordered).toLocaleString()} {line.inventory_items?.unit}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                ₦{Number(line.unit_cost).toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {Number(line.quantity_accepted).toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right font-mono text-blue-700">
                {Math.max(
                  0,
                  Number(line.quantity_ordered) - Number(line.quantity_accepted),
                ).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TimelineRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p>{value ? format(new Date(value), "d MMM yyyy, HH:mm") : "Not reached"}</p>
    </div>
  );
}
