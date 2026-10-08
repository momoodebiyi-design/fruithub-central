/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Item {
  id: string;
  sku: string;
  name: string;
  unit: string;
  category: string;
  quantity: number;
}
interface ConsumptionRow {
  item_id: string;
  unit_quantity: number | null;
  expected_quantity: string;
  quantity: string;
  waste_quantity: string;
  variance_reason: string;
}

type CrossedStocktake = {
  item_id: string;
  stocktake_id: string;
  count_number: string;
};

function lagosDateTimeInput() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replace(" ", "T");
}

function productionTimeUtc(value: string) {
  if (!value) return null;
  const parsed = new Date(`${value}:00+01:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function batchNumberForDate(value: string) {
  const [date, time] = value.split("T");
  if (!date || !time) return "";
  return `B-${date.replaceAll("-", "")}-${time.replace(":", "")}`;
}

const emptyRow = (): ConsumptionRow => ({
  item_id: "",
  unit_quantity: null,
  expected_quantity: "",
  quantity: "",
  waste_quantity: "0",
  variance_reason: "",
});

export function RecordProductionDialog({
  onClose,
  onSaved,
  canBackdate,
}: {
  onClose: () => void;
  onSaved: () => void;
  canBackdate: boolean;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [outputItemId, setOutputItemId] = useState("");
  const [outputQty, setOutputQty] = useState("");
  const [producedLocal, setProducedLocal] = useState(lagosDateTimeInput);
  const [batchNumber, setBatchNumber] = useState(() => batchNumberForDate(producedLocal));
  const [lateEntryReason, setLateEntryReason] = useState("");
  const [stocktakeTreatment, setStocktakeTreatment] = useState("");
  const [crossedStocktakes, setCrossedStocktakes] = useState<CrossedStocktake[]>([]);
  const [stocktakeCheck, setStocktakeCheck] = useState<"loading" | "ready" | "error">("ready");
  const [qcNotes, setQcNotes] = useState("");
  const [exceptionReason, setExceptionReason] = useState("");
  const [setupId, setSetupId] = useState<string | null>(null);
  const [loadingSetup, setLoadingSetup] = useState(false);
  const [rows, setRows] = useState<ConsumptionRow[]>([]);
  const [saving, setSaving] = useState(false);
  const todayInLagos = lagosDateTimeInput().slice(0, 10);
  const isBackdated = producedLocal.slice(0, 10) < todayInLagos;
  const actualProducedAt = productionTimeUtc(producedLocal);
  const selectedItemIds = [
    ...new Set([outputItemId, ...rows.map((row) => row.item_id)].filter(Boolean)),
  ];
  const selectedItemKey = selectedItemIds.sort().join(",");

  useEffect(() => {
    (async () => {
      const { data, error } = await (supabase as any)
        .from("v_central_item_stock")
        .select("item_id, sku, name, unit, category, on_hand")
        .eq("status", "active")
        .order("name");
      if (error) return toast.error(`Unable to load Central stock: ${error.message}`);
      setItems(
        ((data ?? []) as any[]).map((r) => ({
          id: r.item_id,
          sku: r.sku,
          name: r.name,
          unit: r.unit,
          category: r.category,
          quantity: Number(r.on_hand ?? 0),
        })),
      );
    })();
  }, []);

  useEffect(() => {
    if (!canBackdate || !actualProducedAt || !selectedItemKey) {
      setCrossedStocktakes([]);
      setStocktakeCheck("ready");
      return;
    }
    let cancelled = false;
    setStocktakeCheck("loading");
    const timer = window.setTimeout(async () => {
      const { data, error } = await supabase.rpc("preview_backdated_production_stocktakes", {
        _produced_at: actualProducedAt,
        _item_ids: selectedItemKey.split(","),
      });
      if (cancelled) return;
      if (error) {
        setCrossedStocktakes([]);
        setStocktakeCheck("error");
      } else {
        setCrossedStocktakes((data as CrossedStocktake[]) ?? []);
        setStocktakeCheck("ready");
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [actualProducedAt, canBackdate, selectedItemKey]);

  useEffect(() => {
    if (!outputItemId) {
      setRows([]);
      setSetupId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingSetup(true);
      const { data } = await (supabase as any)
        .from("recipes")
        .select("id, recipe_ingredients(ingredient_item_id, quantity)")
        .eq("product_item_id", outputItemId)
        .eq("status", "approved")
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      const components = ((data?.recipe_ingredients ?? []) as any[]).filter((component) =>
        items.some(
          (item) =>
            item.id === component.ingredient_item_id &&
            ["packaging", "consumable"].includes(item.category),
        ),
      );
      setSetupId(components.length ? data.id : null);
      const multiplier = Number(outputQty || 0);
      setRows(
        components.map((component) => {
          const expected = Number(component.quantity ?? 0) * multiplier;
          return {
            item_id: component.ingredient_item_id,
            unit_quantity: Number(component.quantity ?? 0),
            expected_quantity: String(expected),
            quantity: expected > 0 ? String(expected) : "",
            waste_quantity: "0",
            variance_reason: "",
          };
        }),
      );
      setLoadingSetup(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [outputItemId, outputQty, items]);

  const outputItems = items.filter((item) => item.category === "finished_good");
  const packagingItems = items.filter((item) =>
    ["packaging", "consumable"].includes(item.category),
  );

  function updateRow(index: number, patch: Partial<ConsumptionRow>) {
    if (patch.item_id) setStocktakeTreatment("");
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function submit() {
    if (!batchNumber.trim()) return toast.error("Enter a batch number");
    if (!actualProducedAt || new Date(actualProducedAt).getTime() > Date.now() + 5 * 60_000) {
      return toast.error("Choose a production date and time that is not in the future");
    }
    if (isBackdated && !canBackdate) {
      return toast.error("Only Management or Admin can record previous-day production");
    }
    if (isBackdated && lateEntryReason.trim().length < 5) {
      return toast.error("Explain why this batch is being recorded late");
    }
    if (canBackdate && stocktakeCheck !== "ready") {
      return toast.error("Wait for the Central stocktake check to complete");
    }
    if (crossedStocktakes.length > 0 && !stocktakeTreatment) {
      return toast.error("Choose how the later Central stocktake affects stock");
    }
    if (!outputItemId) return toast.error("Pick a finished product");
    const outQ = Number(outputQty);
    if (!outQ || outQ <= 0) return toast.error("Enter output quantity");
    if (!setupId && !exceptionReason.trim())
      return toast.error("Explain why this batch has no approved Packaging Setup");
    const consumption = rows
      .filter((row) => row.item_id)
      .map((row) => ({
        item_id: row.item_id,
        expected_quantity: row.expected_quantity === "" ? null : Number(row.expected_quantity),
        quantity: Number(row.quantity),
        waste_quantity: Number(row.waste_quantity || 0),
        variance_reason: row.variance_reason.trim() || null,
      }));
    if (!consumption.length) return toast.error("Record the packaging and consumables used");
    if (consumption.some((line) => !line.quantity || line.quantity <= 0 || line.waste_quantity < 0))
      return toast.error("Enter valid packaging quantities");
    if (new Set(consumption.map((line) => line.item_id)).size !== consumption.length)
      return toast.error("Each packaging item can only appear once");
    const invalidVariance = consumption.find(
      (line) =>
        line.expected_quantity != null &&
        (line.quantity !== line.expected_quantity || line.waste_quantity > 0) &&
        !line.variance_reason,
    );
    if (invalidVariance) return toast.error("Explain every packaging variance or waste entry");
    setSaving(true);
    const { error } = await supabase.rpc("record_packaged_production_with_date", {
      _batch_number: batchNumber.trim(),
      _product_item_id: outputItemId,
      _quantity: outQ,
      _consumption: consumption,
      _packaging_exception_reason: exceptionReason.trim() || null,
      _qc_notes: qcNotes.trim() || null,
      _produced_at: actualProducedAt,
      _late_entry_reason: isBackdated ? lateEntryReason.trim() : null,
      _stocktake_treatment: crossedStocktakes.length > 0 ? stocktakeTreatment : null,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Batch recorded; Central stock treatment saved");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record production batch</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Batch number</Label>
            <Input
              value={batchNumber}
              onChange={(e) => setBatchNumber(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="production-time">Date and time produced (Lagos time)</Label>
            <Input
              id="production-time"
              type="datetime-local"
              value={producedLocal}
              max={lagosDateTimeInput()}
              onChange={(event) => {
                const next = event.target.value;
                setBatchNumber((current) =>
                  current === batchNumberForDate(producedLocal)
                    ? batchNumberForDate(next)
                    : current,
                );
                setProducedLocal(next);
                setStocktakeTreatment("");
              }}
            />
            <p className="text-xs text-muted-foreground">
              The app separately records when you enter the batch.
              {!canBackdate && " Previous-day dates require Management or Admin."}
            </p>
          </div>
          {isBackdated && (
            <div className="space-y-2">
              <Label htmlFor="production-late-reason">Reason for recording late</Label>
              <Input
                id="production-late-reason"
                value={lateEntryReason}
                onChange={(event) => setLateEntryReason(event.target.value)}
                placeholder="For example: yesterday's batch sheet was submitted today"
              />
            </div>
          )}
          <div className="border rounded-md p-4 space-y-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
              Finished output
            </p>
            <div className="grid sm:grid-cols-[1fr_160px] gap-3">
              <Select
                value={outputItemId}
                onValueChange={(value) => {
                  setOutputItemId(value);
                  setStocktakeTreatment("");
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Finished product" />
                </SelectTrigger>
                <SelectContent>
                  {outputItems.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}{" "}
                      <span className="text-muted-foreground text-xs ml-1 font-mono">
                        {item.sku}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                min="0"
                step="0.001"
                placeholder="Output quantity"
                value={outputQty}
                onChange={(e) => setOutputQty(e.target.value)}
              />
            </div>
          </div>
          <div className="border rounded-md p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
                  Packaging and consumables used
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Actual usage is deducted from Central stock. Ingredients are deferred.
                </p>
              </div>
              {!setupId && (
                <Button variant="ghost" size="sm" onClick={() => setRows([...rows, emptyRow()])}>
                  <Plus className="size-3.5 mr-1" /> Add
                </Button>
              )}
            </div>
            {loadingSetup && (
              <p className="text-sm text-muted-foreground">Loading approved Packaging Setup…</p>
            )}
            {outputItemId && !loadingSetup && !setupId && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <div className="flex gap-2">
                  <AlertTriangle className="size-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">No approved Packaging Setup</p>
                    <p className="text-xs mt-1">
                      You may record this batch manually, but an exception reason is required.
                    </p>
                  </div>
                </div>
                <Textarea
                  className="mt-3"
                  value={exceptionReason}
                  onChange={(e) => setExceptionReason(e.target.value)}
                  placeholder="Required exception reason"
                />
              </div>
            )}
            {rows.length > 0 && (
              <div className="overflow-x-auto">
                <div className="min-w-[820px] space-y-2">
                  <div className="grid grid-cols-[1fr_110px_110px_100px_1fr_auto] gap-2 px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <div>Item</div>
                    <div>Expected</div>
                    <div>Actual used</div>
                    <div>Waste</div>
                    <div>Variance reason</div>
                    <div />
                  </div>
                  {rows.map((row, index) => {
                    const item = items.find((candidate) => candidate.id === row.item_id);
                    const changed =
                      row.expected_quantity !== "" &&
                      (Number(row.quantity) !== Number(row.expected_quantity) ||
                        Number(row.waste_quantity || 0) > 0);
                    return (
                      <div
                        key={`${row.item_id}-${index}`}
                        className="grid grid-cols-[1fr_110px_110px_100px_1fr_auto] gap-2 items-center"
                      >
                        <Select
                          value={row.item_id}
                          onValueChange={(value) => updateRow(index, { item_id: value })}
                          disabled={!!setupId}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Packaging item" />
                          </SelectTrigger>
                          <SelectContent>
                            {packagingItems.map((candidate) => (
                              <SelectItem key={candidate.id} value={candidate.id}>
                                {candidate.name}{" "}
                                <span className="text-muted-foreground text-xs">
                                  ({candidate.quantity.toLocaleString()} {candidate.unit})
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          disabled
                          value={row.expected_quantity}
                          className="font-mono text-right"
                          placeholder="—"
                        />
                        <Input
                          type="number"
                          min="0"
                          step="0.001"
                          value={row.quantity}
                          onChange={(e) => updateRow(index, { quantity: e.target.value })}
                          className="font-mono text-right"
                          placeholder={item?.unit ?? "qty"}
                        />
                        <Input
                          type="number"
                          min="0"
                          step="0.001"
                          value={row.waste_quantity}
                          onChange={(e) => updateRow(index, { waste_quantity: e.target.value })}
                          className="font-mono text-right"
                        />
                        <Input
                          value={row.variance_reason}
                          onChange={(e) => updateRow(index, { variance_reason: e.target.value })}
                          disabled={!changed}
                          placeholder={changed ? "Required" : "—"}
                        />
                        {!setupId ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setRows(rows.filter((_, i) => i !== index))}
                          >
                            <Trash2 className="size-4 text-muted-foreground" />
                          </Button>
                        ) : (
                          <span className="w-10" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {canBackdate && selectedItemIds.length > 0 && stocktakeCheck === "loading" && (
            <p className="text-sm text-muted-foreground">Checking later Central stocktakes…</p>
          )}
          {canBackdate && stocktakeCheck === "error" && (
            <p className="text-sm text-destructive">
              Central stocktakes could not be checked. Change the production time to retry.
            </p>
          )}
          {crossedStocktakes.length > 0 && (
            <div className="space-y-3 rounded-md border border-brand-orange/30 bg-brand-orange/5 p-3">
              <p className="text-sm font-medium">
                A later Central stocktake covers this output or its packaging
              </p>
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {crossedStocktakes.map((row) => (
                  <li key={row.item_id}>
                    {items.find((item) => item.id === row.item_id)?.name ?? "Item"} ·{" "}
                    {row.count_number}
                  </li>
                ))}
              </ul>
              <Label>How should these items affect Central stock?</Label>
              <Select value={stocktakeTreatment} onValueChange={setStocktakeTreatment}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose after checking the stocktake" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="already_counted">
                    Already counted — do not post them again
                  </SelectItem>
                  <SelectItem value="deduct_now">
                    Not included in the count — post them now
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                This applies only to items covered by a later count. Other output and packaging
                movements post normally; the choice is retained in the audit log.
              </p>
            </div>
          )}
          <div>
            <Label>QC notes</Label>
            <Textarea
              value={qcNotes}
              onChange={(e) => setQcNotes(e.target.value)}
              rows={2}
              placeholder="Optional quality observation"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || loadingSetup}
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            {saving ? "Recording…" : "Record batch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
