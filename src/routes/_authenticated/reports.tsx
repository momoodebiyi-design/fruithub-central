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

type Location = { id: string; name: string; is_default: boolean };
type Product = { id: string; name: string; sku: string; unit: string; category: string };

type StocktakeLineRow = {
  stocktake_id: string;
  item_id: string;
  expected_quantity: number;
  counted_quantity: number | null;
  difference: number | null;
  variance_reason: string | null;
  central_stocktakes: {
    count_number: string;
    scope: string;
    status: string;
    location_id: string;
    created_at: string;
  } | null;
};

type StocktakeCoverageRow = {
  itemId: string;
  sku: string;
  item: string;
  category: string;
  unit: string;
  countStatus: "counted" | "not_counted";
  countNumber: string | null;
  stocktakeStatus: string | null;
  countedAt: string | null;
  expected: number | null;
  counted: number | null;
  difference: number | null;
  varianceReason: string | null;
};

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
  packaging_setup_missing: boolean;
  packaging_exception_reason: string | null;
  material_category: string | null;
  expected_quantity: number | null;
  waste_quantity: number | null;
  packaging_variance: number | null;
  variance_reason: string | null;
};

type ReturnRow = {
  return_id: string;
  return_number: string;
  recorded_at: string;
  reason: string;
  condition_notes: string | null;
  dispatch_id: string;
  dispatch_reference: string;
  shop_id: string;
  shop_name: string;
  source_location_id: string | null;
  source_location: string | null;
  return_line_id: string;
  item_id: string;
  sku: string;
  item_name: string;
  unit: string;
  quantity_returned: number;
  quantity_accepted: number;
  quantity_rejected: number;
  recorded_by_name: string | null;
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
  packaging_setup_missing: boolean;
  packaging_exception_reason: string | null;
  materials: Array<{
    id: string;
    sku: string;
    name: string;
    unit: string;
    quantity: number;
    expected: number | null;
    waste: number;
    variance: number;
    reason: string | null;
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
  const [category, setCategory] = useState("all");
  const [productId, setProductId] = useState("all");
  const [locations, setLocations] = useState<Location[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [dispatches, setDispatches] = useState<DispatchRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [productionRows, setProductionRows] = useState<ProductionRow[]>([]);
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [stocktakeLines, setStocktakeLines] = useState<StocktakeLineRow[]>([]);
  const [stocktakeCountStatus, setStocktakeCountStatus] = useState("all");
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
      returnResult,
      stocktakeResult,
    ] = await Promise.all([
      supabase
        .from("locations")
        .select("id, name, is_default")
        .eq("status", "active")
        .order("name"),
      supabase
        .from("inventory_items")
        .select("id, name, sku, unit, category")
        .eq("status", "active")
        .order("name"),
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
      (supabase as any)
        .from("v_dispatch_return_report")
        .select("*")
        .gte("recorded_at", start)
        .lt("recorded_at", endExclusive)
        .order("recorded_at", { ascending: false })
        .limit(10000),
      (supabase as any)
        .from("central_stocktake_lines")
        .select(
          "stocktake_id, item_id, expected_quantity, counted_quantity, difference, variance_reason, central_stocktakes!inner(count_number, scope, status, location_id, created_at)",
        )
        .gte("central_stocktakes.created_at", start)
        .lt("central_stocktakes.created_at", endExclusive)
        .order("created_at", { referencedTable: "central_stocktakes", ascending: false })
        .limit(10000),
    ]);

    const error =
      locationError ??
      productError ??
      dispatchResult.error ??
      movementResult.error ??
      productionResult.error ??
      returnResult.error ??
      stocktakeResult.error;
    if (error) toast.error(`Unable to load reports: ${error.message}`);
    setLocations((locationRows as Location[]) ?? []);
    setProducts((productRows as Product[]) ?? []);
    setDispatches((dispatchResult.data as DispatchRow[]) ?? []);
    setMovements((movementResult.data as MovementRow[]) ?? []);
    setProductionRows((productionResult.data as ProductionRow[]) ?? []);
    setReturns((returnResult.data as ReturnRow[]) ?? []);
    setStocktakeLines((stocktakeResult.data as StocktakeLineRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // Filters are intentionally applied only when the operator presses Refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  const reportCategories = useMemo(
    () =>
      Array.from(new Set(products.map((product) => product.category))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [products],
  );

  const categoryItemIds = useMemo(
    () =>
      new Set(
        products
          .filter((product) => category === "all" || product.category === category)
          .map((product) => product.id),
      ),
    [category, products],
  );

  const categoryProducts = useMemo(
    () => products.filter((product) => categoryItemIds.has(product.id)),
    [categoryItemIds, products],
  );

  const filteredDispatches = useMemo(
    () =>
      dispatches.filter(
        (row) =>
          (locationId === "all" ||
            row.source_location_id === locationId ||
            row.destination_location_id === locationId) &&
          categoryItemIds.has(row.item_id) &&
          (productId === "all" || row.item_id === productId),
      ),
    [categoryItemIds, dispatches, locationId, productId],
  );

  const filteredMovements = useMemo(
    () =>
      movements.filter(
        (row) =>
          (locationId === "all" || row.location_id === locationId) &&
          categoryItemIds.has(row.item_id) &&
          (productId === "all" || row.item_id === productId),
      ),
    [categoryItemIds, movements, locationId, productId],
  );

  const filteredProductionRows = useMemo(
    () =>
      productionRows.filter(
        (row) =>
          (locationId === "all" || row.location_id === locationId) &&
          categoryItemIds.has(row.product_item_id) &&
          (productId === "all" || row.product_item_id === productId),
      ),
    [categoryItemIds, locationId, productId, productionRows],
  );

  const filteredReturns = useMemo(
    () =>
      returns.filter(
        (row) =>
          (locationId === "all" || row.source_location_id === locationId) &&
          categoryItemIds.has(row.item_id) &&
          (productId === "all" || row.item_id === productId),
      ),
    [categoryItemIds, locationId, productId, returns],
  );

  const stocktakeCoverage = useMemo(() => {
    const centralLocation = locations.find(
      (location) => location.is_default || location.name.toLowerCase() === "main store",
    );
    if (locationId !== "all" && (!centralLocation || locationId !== centralLocation.id)) {
      return [];
    }

    const latestByItem = new Map<string, StocktakeLineRow>();
    const orderedLines = [...stocktakeLines].sort(
      (a, b) =>
        new Date(b.central_stocktakes?.created_at ?? 0).getTime() -
        new Date(a.central_stocktakes?.created_at ?? 0).getTime(),
    );

    for (const line of orderedLines) {
      if (!line.central_stocktakes) continue;
      if (locationId !== "all" && line.central_stocktakes.location_id !== locationId) continue;
      if (!latestByItem.has(line.item_id)) latestByItem.set(line.item_id, line);
    }

    return products
      .filter(
        (product) =>
          categoryItemIds.has(product.id) && (productId === "all" || product.id === productId),
      )
      .map<StocktakeCoverageRow>((product) => {
        const line = latestByItem.get(product.id);
        const counted = line?.counted_quantity == null ? null : Number(line.counted_quantity);
        return {
          itemId: product.id,
          sku: product.sku,
          item: product.name,
          category: product.category,
          unit: product.unit,
          countStatus: counted == null ? "not_counted" : "counted",
          countNumber: line?.central_stocktakes?.count_number ?? null,
          stocktakeStatus: line?.central_stocktakes?.status ?? null,
          countedAt: line?.central_stocktakes?.created_at ?? null,
          expected: line ? Number(line.expected_quantity) : null,
          counted,
          difference: line?.difference == null ? null : Number(line.difference),
          varianceReason: line?.variance_reason ?? null,
        };
      })
      .filter((row) => stocktakeCountStatus === "all" || row.countStatus === stocktakeCountStatus)
      .sort((a, b) => a.category.localeCompare(b.category) || a.item.localeCompare(b.item));
  }, [
    locationId,
    locations,
    productId,
    products,
    categoryItemIds,
    stocktakeCountStatus,
    stocktakeLines,
  ]);

  const stocktakeCounted = stocktakeCoverage.filter((row) => row.countStatus === "counted").length;
  const stocktakeNotCounted = stocktakeCoverage.filter(
    (row) => row.countStatus === "not_counted",
  ).length;

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
        packaging_setup_missing: Boolean(row.packaging_setup_missing),
        packaging_exception_reason: row.packaging_exception_reason,
        materials: [],
      };
      if (row.consumption_id && row.material_item_id && row.material_name) {
        batch.materials.push({
          id: row.consumption_id,
          sku: row.material_sku ?? "",
          name: row.material_name,
          unit: row.material_unit ?? "",
          quantity: Number(row.quantity_used ?? 0),
          expected: row.expected_quantity == null ? null : Number(row.expected_quantity),
          waste: Number(row.waste_quantity ?? 0),
          variance: Number(row.packaging_variance ?? 0),
          reason: row.variance_reason,
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
  const uniqueDispatches = new Set(filteredDispatches.map((row) => row.dispatch_id)).size;
  const returnEvents = new Set(filteredReturns.map((row) => row.return_id)).size;
  const returnedTotal = filteredReturns.reduce(
    (sum, row) => sum + Number(row.quantity_returned),
    0,
  );
  const acceptedTotal = filteredReturns.reduce(
    (sum, row) => sum + Number(row.quantity_accepted),
    0,
  );
  const rejectedTotal = filteredReturns.reduce(
    (sum, row) => sum + Number(row.quantity_rejected),
    0,
  );
  const dispatchFrequency = useMemo(() => {
    const map = new Map<
      string,
      { destination: string; dispatchIds: Set<string>; units: number; returned: number }
    >();
    for (const row of filteredDispatches) {
      const current = map.get(row.destination_name) ?? {
        destination: row.destination_name,
        dispatchIds: new Set<string>(),
        units: 0,
        returned: 0,
      };
      current.dispatchIds.add(row.dispatch_id);
      current.units += Number(row.quantity_dispatched);
      current.returned += Number(row.quantity_returned);
      map.set(row.destination_name, current);
    }
    return Array.from(map.values())
      .map((row) => ({ ...row, frequency: row.dispatchIds.size }))
      .sort((a, b) => b.frequency - a.frequency || b.units - a.units);
  }, [filteredDispatches]);

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
        material?.expected,
        material?.variance,
        material?.waste,
        material?.reason,
        material?.unit,
        batch.packaging_setup_missing ? "Yes" : "No",
        batch.packaging_exception_reason,
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
        "Expected quantity",
        "Variance",
        "Waste",
        "Variance reason",
        "Material unit",
        "Packaging setup missing",
        "Packaging exception reason",
        "QC notes",
      ],
      rows,
    );
  }

  function exportReturns() {
    downloadCsv(
      `factory-return-report-${fromDate}-to-${toDate}.csv`,
      [
        "Recorded at",
        "Return",
        "Dispatch",
        "Shop",
        "SKU",
        "Product",
        "Returned",
        "Accepted",
        "Rejected",
        "Unit",
        "Reason",
        "Condition notes",
        "Recorded by",
      ],
      filteredReturns.map((row) => [
        row.recorded_at,
        row.return_number,
        row.dispatch_reference,
        row.shop_name,
        row.sku,
        row.item_name,
        row.quantity_returned,
        row.quantity_accepted,
        row.quantity_rejected,
        row.unit,
        row.reason,
        row.condition_notes,
        row.recorded_by_name,
      ]),
    );
  }

  function exportStocktakeCoverage() {
    downloadCsv(
      `central-stocktake-coverage-${fromDate}-to-${toDate}.csv`,
      [
        "SKU",
        "Product",
        "Category",
        "Count status",
        "Stocktake",
        "Stocktake workflow status",
        "Stocktake started at",
        "Expected quantity",
        "Counted quantity",
        "Difference",
        "Unit",
        "Variance reason",
      ],
      stocktakeCoverage.map((row) => [
        row.sku,
        row.item,
        row.category.replaceAll("_", " "),
        row.countStatus === "counted" ? "Counted" : "Not counted",
        row.countNumber,
        row.stocktakeStatus,
        row.countedAt,
        row.expected,
        row.counted,
        row.difference,
        row.unit,
        row.varianceReason,
      ]),
    );
  }

  const exportCurrentReport =
    tab === "dispatches"
      ? exportDispatches
      : tab === "movements"
        ? exportMovements
        : tab === "production"
          ? exportProduction
          : tab === "returns"
            ? exportReturns
            : exportStocktakeCoverage;

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
            Factory dispatch, return, inventory movement, stocktake coverage and production records
            in Africa/Lagos time.
          </p>
        </div>
        <Button variant="outline" onClick={exportCurrentReport} disabled={loading}>
          <Download className="mr-2 size-4" /> Export current report
        </Button>
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
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
            <Label>Category</Label>
            <Select
              value={category}
              onValueChange={(value) => {
                setCategory(value);
                const selectedProduct = products.find((product) => product.id === productId);
                if (selectedProduct && value !== "all" && selectedProduct.category !== value) {
                  setProductId("all");
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {reportCategories.map((productCategory) => (
                  <SelectItem key={productCategory} value={productCategory}>
                    {productCategory.replaceAll("_", " ")}
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
                {categoryProducts.map((product) => (
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
          <TabsTrigger value="stocktakes">Stocktake coverage</TabsTrigger>
          <TabsTrigger value="production">Production</TabsTrigger>
          <TabsTrigger value="returns">Factory returns</TabsTrigger>
        </TabsList>

        <TabsContent value="dispatches" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard label="Dispatch events" value={uniqueDispatches} />
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
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Dispatch frequency by destination</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Destination</th>
                    <th className="px-3 py-2 text-right">Dispatches</th>
                    <th className="px-3 py-2 text-right">Units sent</th>
                    <th className="px-3 py-2 text-right">Units returned</th>
                    <th className="px-3 py-2 text-right">Return rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {dispatchFrequency.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-8 text-center text-muted-foreground">
                        No dispatch frequency data in this period.
                      </td>
                    </tr>
                  ) : (
                    dispatchFrequency.map((row) => (
                      <tr key={row.destination}>
                        <td className="px-3 py-2 font-medium">{row.destination}</td>
                        <td className="px-3 py-2 text-right font-mono">{row.frequency}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {row.units.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {row.returned.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {row.units ? `${((row.returned / row.units) * 100).toFixed(1)}%` : "0%"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
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

        <TabsContent value="stocktakes" className="space-y-4">
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Every active product is listed. A blank or omitted count remains “Not counted” and is
            never silently treated as zero. Where multiple stocktakes fall in the selected dates,
            the latest count for each product is shown.
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard label="Products shown" value={stocktakeCoverage.length} />
            <SummaryCard label="Counted" value={stocktakeCounted} />
            <SummaryCard label="Not counted" value={stocktakeNotCounted} />
          </div>

          <Card>
            <CardContent className="pt-6 sm:max-w-sm">
              <div>
                <Label>Count status</Label>
                <Select value={stocktakeCountStatus} onValueChange={setStocktakeCountStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Counted and not counted</SelectItem>
                    <SelectItem value="not_counted">Not counted</SelectItem>
                    <SelectItem value="counted">Counted</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[1050px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-left">Category</th>
                  <th className="px-3 py-2 text-left">Count status</th>
                  <th className="px-3 py-2 text-left">Stocktake</th>
                  <th className="px-3 py-2 text-right">Expected</th>
                  <th className="px-3 py-2 text-right">Counted</th>
                  <th className="px-3 py-2 text-right">Difference</th>
                  <th className="px-3 py-2 text-left">Variance reason</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {stocktakeCoverage.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                      No products match the selected filters.
                    </td>
                  </tr>
                ) : (
                  stocktakeCoverage.map((row) => (
                    <tr key={row.itemId}>
                      <td className="px-3 py-2">
                        <p className="font-medium">{row.item}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{row.sku}</p>
                      </td>
                      <td className="px-3 py-2 capitalize">{row.category.replaceAll("_", " ")}</td>
                      <td className="px-3 py-2">
                        <Badge
                          variant="outline"
                          className={
                            row.countStatus === "counted"
                              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                              : "border-amber-300 bg-amber-50 text-amber-800"
                          }
                        >
                          {row.countStatus === "counted" ? "Counted" : "Not counted"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        {row.countNumber ? (
                          <>
                            <p className="font-mono text-xs">{row.countNumber}</p>
                            <p className="text-[11px] capitalize text-muted-foreground">
                              {row.stocktakeStatus} · {formatLagosDateTime(row.countedAt!)}
                            </p>
                          </>
                        ) : (
                          <span className="text-muted-foreground">No count in period</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {row.expected == null ? "—" : row.expected.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {row.counted == null ? "—" : row.counted.toLocaleString()}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono ${row.difference ? "text-brand-orange" : ""}`}
                      >
                        {row.difference == null
                          ? "—"
                          : row.difference > 0
                            ? `+${row.difference}`
                            : row.difference}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {row.varianceReason ?? "—"}
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
            <SummaryCard label="Packaging lines" value={productionMaterialLines} />
          </div>

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[1050px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Time</th>
                  <th className="px-3 py-2 text-left">Batch</th>
                  <th className="px-3 py-2 text-left">Output product</th>
                  <th className="px-3 py-2 text-right">Output</th>
                  <th className="px-3 py-2 text-left">Packaging used</th>
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
                                {material.expected != null && material.variance !== 0 && (
                                  <span className="text-brand-orange">
                                    {" "}
                                    · variance {material.variance > 0 ? "+" : ""}
                                    {material.variance}
                                  </span>
                                )}
                                {material.waste > 0 && (
                                  <span className="text-amber-700"> · waste {material.waste}</span>
                                )}
                              </p>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">{batch.status}</Badge>
                        {batch.packaging_setup_missing && (
                          <Badge variant="outline" className="ml-1 text-amber-700 border-amber-300">
                            Manual setup
                          </Badge>
                        )}
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

        <TabsContent value="returns" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <SummaryCard label="Return events" value={returnEvents} />
            <SummaryCard label="Units returned" value={returnedTotal} />
            <SummaryCard label="Accepted to Central" value={acceptedTotal} />
            <SummaryCard label="Rejected" value={rejectedTotal} />
          </div>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[1050px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Time</th>
                  <th className="px-3 py-2 text-left">Return / dispatch</th>
                  <th className="px-3 py-2 text-left">Shop</th>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-right">Returned</th>
                  <th className="px-3 py-2 text-right">Accepted</th>
                  <th className="px-3 py-2 text-right">Rejected</th>
                  <th className="px-3 py-2 text-left">Reason</th>
                  <th className="px-3 py-2 text-left">Recorded by</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredReturns.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center text-muted-foreground">
                      No factory returns in this period.
                    </td>
                  </tr>
                ) : (
                  filteredReturns.map((row) => (
                    <tr key={row.return_line_id}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatLagosDateTime(row.recorded_at)}
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-mono text-xs">{row.return_number}</p>
                        <p className="text-[11px] text-muted-foreground font-mono">
                          {row.dispatch_reference}
                        </p>
                      </td>
                      <td className="px-3 py-2">{row.shop_name}</td>
                      <td className="px-3 py-2">
                        <p>{row.item_name}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{row.sku}</p>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {Number(row.quantity_returned)} {row.unit}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-700">
                        {Number(row.quantity_accepted)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-brand-orange">
                        {Number(row.quantity_rejected)}
                      </td>
                      <td className="px-3 py-2">
                        <p>{row.reason}</p>
                        <p className="text-[11px] text-muted-foreground">{row.condition_notes}</p>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {row.recorded_by_name ?? "—"}
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
