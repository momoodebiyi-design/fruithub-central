import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Download, Upload } from "lucide-react";

type Category = "raw_material" | "packaging" | "finished_good" | "consumable";
const CATEGORIES: Category[] = ["raw_material", "packaging", "finished_good", "consumable"];

const TARGET_FIELDS = [
  { key: "sku", label: "SKU", required: false },
  { key: "name", label: "Item name", required: true },
  { key: "category", label: "Category", required: true },
  { key: "unit", label: "Unit", required: true },
  { key: "quantity", label: "Opening quantity", required: false },
  { key: "min_level", label: "Minimum stock", required: false },
  { key: "reorder_level", label: "Reorder level", required: false },
  { key: "location", label: "Location", required: false },
] as const;

type FieldKey = (typeof TARGET_FIELDS)[number]["key"];

function autoGuess(header: string, target: FieldKey): boolean {
  const h = header.toLowerCase().replace(/[\s_-]+/g, "");
  const map: Record<FieldKey, string[]> = {
    sku: ["sku", "code", "itemcode"],
    name: ["name", "itemname", "product", "description"],
    category: ["category", "type", "cat"],
    unit: ["unit", "uom", "measure"],
    quantity: ["quantity", "qty", "openingstock", "stock", "onhand"],
    min_level: ["min", "minimum", "minstock", "minlevel"],
    reorder_level: ["reorder", "reorderlevel", "reorderpoint"],
    location: ["location", "warehouse", "shelf", "bin"],
  };
  return map[target].some((k) => h.includes(k));
}

function normalizeCategory(v: unknown): Category | null {
  if (!v) return null;
  const s = String(v).toLowerCase().replace(/[\s-]+/g, "_");
  if (CATEGORIES.includes(s as Category)) return s as Category;
  if (s.includes("raw")) return "raw_material";
  if (s.includes("pack")) return "packaging";
  if (s.includes("finish") || s.includes("juice") || s.includes("product")) return "finished_good";
  if (s.includes("consum") || s.includes("misc")) return "consumable";
  return null;
}

function slugSku(name: string) {
  return (
    "IMP-" +
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) +
    "-" +
    Math.random().toString(36).slice(2, 5).toUpperCase()
  );
}

export function BulkImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [mapping, setMapping] = useState<Record<FieldKey, string>>({} as Record<FieldKey, string>);
  const [step, setStep] = useState<"upload" | "map" | "preview">("upload");
  const [importing, setImporting] = useState(false);

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      ["SKU", "Item Name", "Category", "Unit", "Quantity", "Minimum Stock", "Reorder Level", "Location"],
      ["FR-ORNG-01", "Orange Juice 500ml", "finished_good", "bottle", 120, 50, 100, "Cold storage A"],
      ["", "Fresh Oranges", "raw_material", "kg", 300, 100, 200, "Receiving"],
      ["", "500ml Bottle", "packaging", "unit", 5000, 1000, 2000, "Store B"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Inventory");
    XLSX.writeFile(wb, "inventory-import-template.xlsx");
  }

  async function onFile(f: File) {
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return toast.error("Empty workbook");
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
    if (!json.length) return toast.error("No rows found");
    const hs = Object.keys(json[0]);
    setHeaders(hs);
    setRows(json);
    // Auto-map
    const m = {} as Record<FieldKey, string>;
    for (const t of TARGET_FIELDS) {
      const found = hs.find((h) => autoGuess(h, t.key));
      if (found) m[t.key] = found;
    }
    setMapping(m);
    setStep("map");
  }

  const previewRows = useMemo(() => {
    return rows.slice(0, 5).map((r) => {
      const out: Record<string, unknown> = {};
      for (const t of TARGET_FIELDS) {
        const src = mapping[t.key];
        out[t.key] = src ? r[src] : "";
      }
      return out;
    });
  }, [rows, mapping]);

  const missingRequired = TARGET_FIELDS.filter((t) => t.required && !mapping[t.key]);

  async function doImport() {
    setImporting(true);
    const { data: userData } = await supabase.auth.getUser();
    const performed_by = userData.user?.id;

    let created = 0;
    let updated = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const raw of rows) {
      const name = String(raw[mapping.name] ?? "").trim();
      const category = normalizeCategory(raw[mapping.category]);
      const unit = String(raw[mapping.unit] ?? "").trim();
      if (!name || !category || !unit) {
        failed++;
        continue;
      }
      const sku = String(raw[mapping.sku] ?? "").trim().toUpperCase() || slugSku(name);
      const qty = Number(raw[mapping.quantity]) || 0;
      const min_level = Number(raw[mapping.min_level]) || 0;
      const reorder_level = Number(raw[mapping.reorder_level]) || 0;
      const location = String(raw[mapping.location] ?? "").trim() || null;

      // Try to find existing by SKU
      const { data: existing } = await supabase
        .from("inventory_items")
        .select("id, quantity")
        .eq("sku", sku)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("inventory_items")
          .update({ name, category, unit, min_level, reorder_level, location })
          .eq("id", existing.id);
        if (error) {
          failed++;
          errors.push(`${sku}: ${error.message}`);
          continue;
        }
        // If import specifies a quantity, log a delta as adjustment
        if (qty && qty !== Number(existing.quantity)) {
          const delta = qty - Number(existing.quantity);
          await supabase.from("inventory_movements").insert({
            item_id: existing.id,
            type: "adjustment",
            quantity: delta,
            reason: "Bulk import — quantity reconciled",
            performed_by,
          });
        }
        updated++;
      } else {
        const { data: ins, error } = await supabase
          .from("inventory_items")
          .insert({ sku, name, category, unit, min_level, reorder_level, location, quantity: 0 })
          .select("id")
          .single();
        if (error || !ins) {
          failed++;
          errors.push(`${sku}: ${error?.message ?? "insert failed"}`);
          continue;
        }
        if (qty > 0) {
          await supabase.from("inventory_movements").insert({
            item_id: ins.id,
            type: "stock_in",
            quantity: qty,
            reason: "Bulk import — opening stock",
            performed_by,
          });
        }
        created++;
      }
    }

    setImporting(false);
    if (failed > 0) {
      toast.error(`${created} created, ${updated} updated, ${failed} failed`);
      if (errors.length) console.warn("Import errors:", errors);
    } else {
      toast.success(`${created} created, ${updated} updated`);
    }
    onImported();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Bulk import inventory</DialogTitle>
        </DialogHeader>

        {step === "upload" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upload an Excel (.xlsx) or CSV file. The first sheet is used; the first row must be a header.
              Existing SKUs are updated in place; new SKUs are created with opening stock recorded as a stock-in movement.
            </p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={downloadTemplate}>
                <Download className="size-4 mr-2" /> Download template
              </Button>
              <Button
                onClick={() => fileInput.current?.click()}
                className="bg-brand-orange text-white hover:bg-brand-orange/90"
              >
                <Upload className="size-4 mr-2" /> Choose file
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx,.xls,.csv"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                }}
              />
            </div>
          </div>
        )}

        {step === "map" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Match your columns to the inventory fields. Required fields are marked with *.
            </p>
            <div className="grid grid-cols-2 gap-3 max-h-80 overflow-auto pr-2">
              {TARGET_FIELDS.map((t) => (
                <div key={t.key}>
                  <Label>
                    {t.label} {t.required && <span className="text-brand-orange">*</span>}
                  </Label>
                  <Select
                    value={mapping[t.key] ?? "__none__"}
                    onValueChange={(v) =>
                      setMapping((m) => ({ ...m, [t.key]: v === "__none__" ? "" : v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="— none —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— none —</SelectItem>
                      {headers.map((h) => (
                        <SelectItem key={h} value={h}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {missingRequired.length > 0 && (
              <p className="text-xs text-brand-orange">
                Missing required: {missingRequired.map((m) => m.label).join(", ")}
              </p>
            )}
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              First 5 rows shown. {rows.length} total rows will be imported.
            </p>
            <div className="border rounded-md overflow-auto max-h-80">
              <Table>
                <TableHeader>
                  <TableRow>
                    {TARGET_FIELDS.map((t) => (
                      <TableHead key={t.key}>{t.label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewRows.map((r, i) => (
                    <TableRow key={i}>
                      {TARGET_FIELDS.map((t) => (
                        <TableCell key={t.key} className="text-xs whitespace-nowrap">
                          {String(r[t.key] ?? "")}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {step === "map" && (
            <Button
              onClick={() => setStep("preview")}
              disabled={missingRequired.length > 0}
              className="bg-brand-orange text-white hover:bg-brand-orange/90"
            >
              Preview →
            </Button>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("map")}>
                ← Back
              </Button>
              <Button
                onClick={doImport}
                disabled={importing}
                className="bg-brand-orange text-white hover:bg-brand-orange/90"
              >
                {importing ? "Importing…" : `Import ${rows.length} rows`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
