/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Download, FileBarChart, MoveRight } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import { CAN_VIEW_REPORTS, hasAny } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

export const Route = createFileRoute("/_authenticated/reports")({
  component: ReportsPage,
});

type Location = { id: string; name: string };
type Product = { id: string; name: string; sku: string };

type DispatchRow = {
  dispatch_id: string;
  reference: string;
  dispatched_at: string;
  received_at: string | null;
  status: string;
  destination_type: string;
  destination_name: string;
  shop_id: string | null;
  client_id: string | null;
  source_location_id: string | null;
  destination_location_id: string | null;
  source_location: string | null;
  destination_location: string | null;
  dispatch_line_id: string;
  item_id: string;
  sku: string;
  item_name: string;
  unit: string;
  quantity_dispatched: number;
  quantity_returned: number;
  net_quantity: number;
  dispatched_by_name: string | null;
  received_by_name: string | null;
};

type MovementRow = {
  movement_id: string;
  created_at: string;
  movement_date: string;
  type: string;
  signed_quantity: number;
  direction: "in" | "out" | "adjustment";
  quantity: number;
  reason: string | null;
  source: string | null;
  location_id: string | null;
  location_name: string | null;
  item_id: string;
  sku: string;
  item_name: string;
  unit: string;
  dispatch_reference: string | null;
  from_shop_name: string | null;
  to_shop_name: string | null;
  from_client_name: string | null;
  to_client_name: string | null;
  performed_by: string | null;
  performed_by_name: string | null;
};

type MovementSummary = {
  key: string;
  location: string;
  sku: string;
  item: string;
  unit: string;
  opening: number;
  stockIn: number;
  stockOut: number;
  closing: number;
};

type ProductionRow = {
  batch_id: string;
  batch_number: string;
  produced_at: string;
  status: string;
  qc_notes: string | null;
  quantity_produced: number;
  product_item_id: string;
  product_sku: string;
  product_name: string;
  product_unit: string;
  location_id: string | null;
  location_name: string | null;
  staff_id: string | null;
  staff_name: string | null;
  consumption_id: string | null;
  material_item_id: string | null;
  material_sku: string | null;
  material_name: string | null;
  material_unit: string | null;
  quantity_used: number | null;
};

type ProductionBatch = {
  batch_id: string;
  batch_number: string;
  produced_at: string;
  status: string;
  qc_notes: string | null;
  quantity_produced: number;
  product_item_id: string;
  product_sku: string;
  product_name: string;
  product_unit: string;
  location_name: string | null;
  staff_name: string | null;
  materials: Array<{
    id: string;
    sku: string;
    name: string;
    unit: string;
    quantity: number;
  }>;
};

const STATUS_COLORS: Record<string, string> = {
  dispatched: "border-brand-orange/30 bg-brand-orange/5 text-brand-orange",
  received: "border-blue-200 bg-blue-50 text-blue-700",
  reconciled: "border-emerald-200 bg-emerald-50 text-emerald-700",
  cancelled: "text-muted-foreground",
};

function todayInLagos() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
}

function lagosBoundary(date: string, addDays = 0) {
  const value = new Date(`${date}T00:00:00+01:00`);
  value.setUTCDate(value.getUTCDate() + addDays);
  return value.toISOString();
}

function formatLagosDateTime(value: string) {
  return new Intl.DateTimeFormat("en-NG", {
    timeZone: "Africa/Lagos",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function escapeCsv(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  const body = [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function ReportsPage() {
  const session = useSession();
  const canView = hasAny(session.roles, CAN_VIEW_REPORTS);
  const today = todayInLagos();
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [locationId, setLocationId] = useState("all");
  const [productId, setProductId] = useState("all");
  const [locations, setLocations] = useState<Location[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [dispatches, setDispatches] = useState<DispatchRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [productionRows, setProductionRows] = useState<ProductionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("dispatches");

  async function load() {
    if (!canView) return;
    if (toDate < fromDate) {
      toast.error("The end date cannot be before the start date");
      return;
    }
    setLoading(true);
    const start = lagosBoundary(fromDate);
    const endExclusive = lagosBoundary(toDate, 1);

    const [
      { data: locationRows, error: locationError },
      { data: productRows, error: productError },
      dispatchResult,
      movementResult,
      productionResult,
    ] = await Promise.all([
      supabase.from("locations").select("id, name").eq("status", "active").order("name"),
      supabase.from("inventory_items").select("id, name, sku").eq("status", "active").order("name"),
      (supabase as any)
        .from("v_daily_dispatch_report")
        .select("*")
        .gte("dispatched_at", start)
        .lt("dispatched_at", endExclusive)
        .order("dispatched_at", { ascending: false })
        .limit(10000),
      (supabase as any)
        .from("v_inventory_movement_report")
        .select("*")
        .lt("created_at", endExclusive)
        .order("created_at", { ascending: false })
        .limit(10000),
      (supabase as any)
        .from("v_production_report")
        .select("*")
        .gte("produced_at", start)
        .lt("produced_at", endExclusive)
        .order("produced_at", { ascending: false })
        .limit(10000),
    ]);

    const error =
      locationError ??
      productError ??
      dispatchResult.error ??
      movementResult.error ??
      productionResult.error;
    if (error) toast.error(`Unable to load reports: ${error.message}`);
    setLocations((locationRows as Location[]) ?? []);
    setProducts((productRows as Product[]) ?? []);
    setDispatches((dispatchResult.data as DispatchRow[]) ?? []);
    setMovements((movementResult.data as MovementRow[]) ?? []);
    setProductionRows((productionResult.data as ProductionRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // Filters are intentionally applied only when the operator presses Refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  const filteredDispatches = useMemo(
    () =>
      dispatches.filter(
        (row) =>
          (locationId === "all" ||
            row.source_location_id === locationId ||
            row.destination_location_id === locationId) &&
          (productId === "all" || row.item_id === productId),
      ),
    [dispatches, locationId, productId],
  );

  const filteredMovements = useMemo(
    () =>
      movements.filter(
        (row) =>
          (locationId === "all" || row.location_id === locationId) &&
          (productId === "all" || row.item_id === productId),
      ),
    [movements, locationId, productId],
  );

  const filteredProductionRows = useMemo(
    () =>
      productionRows.filter(
        (row) =>
          (locationId === "all" || row.location_id === locationId) &&
          (productId === "all" || row.product_item_id === productId),
      ),
    [productionRows, locationId, productId],
  );

  const productionBatches = useMemo(() => {
    const map = new Map<string, ProductionBatch>();
    for (const row of filteredProductionRows) {
      const batch = map.get(row.batch_id) ?? {
        batch_id: row.batch_id,
        batch_number: row.batch_number,
        produced_at: row.produced_at,
        status: row.status,
        qc_notes: row.qc_notes,
        quantity_produced: Number(row.quantity_produced),
        product_item_id: row.product_item_id,
        product_sku: row.product_sku,
        product_name: row.product_name,
        product_unit: row.product_unit,
        location_name: row.location_name,
        staff_name: row.staff_name,
        materials: [],
      };
      if (row.consumption_id && row.material_item_id && row.material_name) {
        batch.materials.push({
          id: row.consumption_id,
          sku: row.material_sku ?? "",
          name: row.material_name,
          unit: row.material_unit ?? "",
          quantity: Number(row.quantity_used ?? 0),
        });
      }
      map.set(row.batch_id, batch);
    }
    return Array.from(map.values()).sort(
      (a, b) => new Date(b.produced_at).getTime() - new Date(a.produced_at).getTime(),
    );
  }, [filteredProductionRows]);

  const periodMovements = useMemo(() => {
    const start = lagosBoundary(fromDate);
    return filteredMovements.filter((row) => row.created_at >= start);
  }, [filteredMovements, fromDate]);

  const movementSummary = useMemo(() => {
    const start = lagosBoundary(fromDate);
    const map = new Map<string, MovementSummary>();
    for (const row of filteredMovements) {
      const key = `${row.location_id ?? "unassigned"}:${row.item_id}`;
      const summary = map.get(key) ?? {
        key,
        location: row.location_name ?? "Unassigned",
        sku: row.sku,
        item: row.item_name,
        unit: row.unit,
        opening: 0,
        stockIn: 0,
        stockOut: 0,
        closing: 0,
      };
      const signed = Number(row.signed_quantity);
      if (row.created_at < start) summary.opening += signed;
      else if (signed >= 0) summary.stockIn += signed;
      else summary.stockOut += Math.abs(signed);
      map.set(key, summary);
    }
    return Array.from(map.values())
      .map((row) => ({ ...row, closing: row.opening + row.stockIn - row.stockOut }))
      .filter((row) => row.opening !== 0 || row.stockIn !== 0 || row.stockOut !== 0)
      .sort((a, b) => a.location.localeCompare(b.location) || a.item.localeCompare(b.item));
  }, [filteredMovements, fromDate]);

  const dispatchTotal = filteredDispatches.reduce(
    (sum, row) => sum + Number(row.quantity_dispatched),
    0,
  );
  const movementIn = periodMovements.reduce(
    (sum, row) => sum + Math.max(0, Number(row.signed_quantity)),
    0,
  );
  const movementOut = periodMovements.reduce(
    (sum, row) => sum + Math.max(0, -Number(row.signed_quantity)),
    0,
  );
  const productionOutput = productionBatches.reduce(
    (sum, batch) => sum + batch.quantity_produced,
    0,
  );
  const productionMaterialLines = productionBatches.reduce(
    (sum, batch) => sum + batch.materials.length,
    0,
  );

  function exportDispatches() {
    downloadCsv(
      `dispatch-report-${fromDate}-to-${toDate}.csv`,
      [
        "Dispatched at",
        "Reference",
        "Destination type",
        "Destination",
        "SKU",
        "Product",
        "Quantity dispatched",
        "Returned",
        "Net quantity",
        "Unit",
        "Status",
        "Source",
        "Destination location",
        "Dispatched by",
        "Received at",
        "Received by",
      ],
      filteredDispatches.map((row) => [
        row.dispatched_at,
        row.reference,
        row.destination_type,
        row.destination_name,
        row.sku,
        row.item_name,
        row.quantity_dispatched,
        row.quantity_returned,
        row.net_quantity,
        row.unit,
        row.status,
        row.source_location,
        row.destination_location,
        row.dispatched_by_name,
        row.received_at,
        row.received_by_name,
      ]),
    );
  }

  function exportMovements() {
    downloadCsv(
      `inventory-movement-report-${fromDate}-to-${toDate}.csv`,
      [
        "Created at",
        "Location",
        "SKU",
        "Product",
        "Movement",
        "Direction",
        "Quantity",
        "Signed quantity",
        "Unit",
        "Dispatch reference",
        "From",
        "To",
        "Reason",
        "Source",
        "Performed by",
      ],
      periodMovements.map((row) => [
        row.created_at,
        row.location_name,
        row.sku,
        row.item_name,
        row.type,
        row.direction,
        row.quantity,
        row.signed_quantity,
        row.unit,
        row.dispatch_reference,
        row.from_shop_name ?? row.from_client_name,
        row.to_shop_name ?? row.to_client_name,
        row.reason,
        row.source,
        row.performed_by_name,
      ]),
    );
  }

  function exportProduction() {
    const rows = productionBatches.flatMap((batch) => {
      const materials = batch.materials.length ? batch.materials : [null];
      return materials.map((material) => [
        batch.produced_at,
        batch.batch_number,
        batch.product_sku,
        batch.product_name,
        batch.quantity_produced,
        batch.product_unit,
        batch.location_name,
        batch.status,
        batch.staff_name,
        material?.sku,
        material?.name,
        material?.quantity,
        material?.unit,
        batch.qc_notes,
      ]);
    });
    downloadCsv(
      `production-report-${fromDate}-to-${toDate}.csv`,
      [
        "Produced at",
        "Batch number",
        "Output SKU",
        "Output product",
        "Output quantity",
        "Output unit",
        "Location",
        "Status",
        "Operator",
        "Material SKU",
        "Material",
        "Quantity used",
        "Material unit",
        "QC notes",
      ],
      rows,
    );
  }

  const exportCurrentReport =
    tab === "dispatches"
      ? exportDispatches
      : tab === "movements"
        ? exportMovements
        : exportProduction;

  if (!canView) {
    return (
      <p className="text-sm text-muted-foreground">
        You do not have access to operational reports.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Dispatch, inventory movement and production records in Africa/Lagos time.
          </p>
        </div>
        <Button variant="outline" onClick={exportCurrentReport} disabled={loading}>
          <Download className="mr-2 size-4" /> Export current report
        </Button>
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
          <div>
            <Label>From</Label>
            <Input
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </div>
          <div>
            <Label>To</Label>
            <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
          </div>
          <div>
            <Label>Location</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All locations</SelectItem>
                {locations.map((location) => (
                  <SelectItem key={location.id} value={location.id}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Product / item</Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All products and items</SelectItem>
                {products.map((product) => (
                  <SelectItem key={product.id} value={product.id}>
                    {product.name} ({product.sku})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={load}
            disabled={loading}
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            {loading ? "Loading…" : "Refresh report"}
          </Button>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="dispatches">Products dispatched</TabsTrigger>
          <TabsTrigger value="movements">Inventory movements</TabsTrigger>
          <TabsTrigger value="production">Production</TabsTrigger>
        </TabsList>

        <TabsContent value="dispatches" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard label="Dispatch lines" value={filteredDispatches.length} />
            <SummaryCard label="Units dispatched" value={dispatchTotal} />
            <SummaryCard
              label="Awaiting receipt"
              value={
                new Set(
                  filteredDispatches
                    .filter((row) => row.status === "dispatched")
                    .map((row) => row.dispatch_id),
                ).size
              }
            />
          </div>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[1050px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Time</th>
                  <th className="px-3 py-2 text-left">Reference</th>
                  <th className="px-3 py-2 text-left">Destination</th>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-right">Sent</th>
                  <th className="px-3 py-2 text-right">Returned</th>
                  <th className="px-3 py-2 text-right">Net</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Handled by</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredDispatches.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center text-muted-foreground">
                      No dispatches in this period.
                    </td>
                  </tr>
                ) : (
                  filteredDispatches.map((row) => (
                    <tr key={row.dispatch_line_id}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatLagosDateTime(row.dispatched_at)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{row.reference}</td>
                      <td className="px-3 py-2">
                        <p>{row.destination_name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {row.destination_location ?? row.destination_type.replace("_", " ")}
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <p>{row.item_name}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{row.sku}</p>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {Number(row.quantity_dispatched)} {row.unit}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {Number(row.quantity_returned)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{Number(row.net_quantity)}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className={STATUS_COLORS[row.status] ?? ""}>
                          {row.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {row.dispatched_by_name ?? "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="movements" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard label="Movement records" value={periodMovements.length} />
            <SummaryCard label="Total stock in" value={movementIn} />
            <SummaryCard label="Total stock out" value={movementOut} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Opening and closing summary</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[800px] text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Location</th>
                    <th className="px-3 py-2 text-left">Product</th>
                    <th className="px-3 py-2 text-right">Opening</th>
                    <th className="px-3 py-2 text-right">In</th>
                    <th className="px-3 py-2 text-right">Out</th>
                    <th className="px-3 py-2 text-right">Closing</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {movementSummary.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                        No stock position in this period.
                      </td>
                    </tr>
                  ) : (
                    movementSummary.map((row) => (
                      <tr key={row.key}>
                        <td className="px-3 py-2">{row.location}</td>
                        <td className="px-3 py-2">
                          <p>{row.item}</p>
                          <p className="font-mono text-[11px] text-muted-foreground">{row.sku}</p>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {row.opening.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-emerald-700">
                          {row.stockIn.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-brand-orange">
                          {row.stockOut.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-medium">
                          {row.closing.toLocaleString()} {row.unit}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Time</th>
                  <th className="px-3 py-2 text-left">Location</th>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-left">Movement</th>
                  <th className="px-3 py-2 text-right">Quantity</th>
                  <th className="px-3 py-2 text-left">Reference / reason</th>
                  <th className="px-3 py-2 text-left">Performed by</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {periodMovements.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      No movements in this period.
                    </td>
                  </tr>
                ) : (
                  periodMovements.map((row) => (
                    <tr key={row.movement_id}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatLagosDateTime(row.created_at)}
                      </td>
                      <td className="px-3 py-2">{row.location_name ?? "Unassigned"}</td>
                      <td className="px-3 py-2">
                        <p>{row.item_name}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{row.sku}</p>
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1 capitalize">
                          <MoveRight className="size-3" />
                          {row.type.replaceAll("_", " ")}
                        </span>
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono ${Number(row.signed_quantity) < 0 ? "text-brand-orange" : "text-emerald-700"}`}
                      >
                        {Number(row.signed_quantity) > 0 ? "+" : ""}
                        {Number(row.signed_quantity).toLocaleString()} {row.unit}
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-mono text-xs">
                          {row.dispatch_reference ?? row.source ?? "—"}
                        </p>
                        <p className="text-[11px] text-muted-foreground">{row.reason ?? ""}</p>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {row.performed_by_name ?? "System"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="production" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard label="Batches" value={productionBatches.length} />
            <SummaryCard label="Total output" value={productionOutput} />
            <SummaryCard label="Material lines" value={productionMaterialLines} />
          </div>

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[1050px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Time</th>
                  <th className="px-3 py-2 text-left">Batch</th>
                  <th className="px-3 py-2 text-left">Output product</th>
                  <th className="px-3 py-2 text-right">Output</th>
                  <th className="px-3 py-2 text-left">Materials used</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Operator</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {productionBatches.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      No production batches in this period.
                    </td>
                  </tr>
                ) : (
                  productionBatches.map((batch) => (
                    <tr key={batch.batch_id}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatLagosDateTime(batch.produced_at)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{batch.batch_number}</td>
                      <td className="px-3 py-2">
                        <p>{batch.product_name}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {batch.product_sku}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {batch.quantity_produced.toLocaleString()} {batch.product_unit}
                      </td>
                      <td className="px-3 py-2">
                        {batch.materials.length === 0 ? (
                          <span className="text-muted-foreground">None recorded</span>
                        ) : (
                          <div className="space-y-1">
                            {batch.materials.map((material) => (
                              <p key={material.id} className="text-xs">
                                {material.name}: {material.quantity.toLocaleString()}{" "}
                                {material.unit}
                              </p>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">{batch.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {batch.staff_name ?? "System"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 pt-6">
        <div className="rounded-md bg-brand-orange/10 p-2 text-brand-orange">
          <FileBarChart className="size-4" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold font-mono">{value.toLocaleString()}</p>
        </div>
      </CardContent>
    </Card>
  );
}
