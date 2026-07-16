import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Download, Upload } from "lucide-react";

export type ContactKind = "client" | "supplier";

const FIELDS_BASE = [
  { key: "name", label: "Business name", required: true },
  { key: "contact_name", label: "Contact person", required: false },
  { key: "phone", label: "Phone", required: false },
  { key: "email", label: "Email", required: false },
  { key: "notes", label: "Notes", required: false },
] as const;

const CLIENT_ONLY = [{ key: "address", label: "Address", required: false }] as const;

type FieldKey = "name" | "contact_name" | "phone" | "email" | "notes" | "address";

function guess(header: string, target: FieldKey) {
  const h = header.toLowerCase().replace(/[\s_-]+/g, "");
  const map: Record<FieldKey, string[]> = {
    name: ["name", "business", "company", "client", "supplier"],
    contact_name: ["contact", "person", "attn"],
    phone: ["phone", "mobile", "tel", "cell"],
    email: ["email", "mail"],
    address: ["address", "location", "street", "city"],
    notes: ["notes", "remark", "comment"],
  };
  return map[target].some((k) => h.includes(k));
}

export function ContactsImportDialog({
  kind,
  onClose,
  onImported,
}: {
  kind: ContactKind;
  onClose: () => void;
  onImported: () => void;
}) {
  const fields = kind === "client" ? [...FIELDS_BASE, ...CLIENT_ONLY] : FIELDS_BASE;
  const fileInput = useRef<HTMLInputElement>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<FieldKey, string>>>({});
  const [step, setStep] = useState<"upload" | "map" | "preview">("upload");
  const [importing, setImporting] = useState(false);

  function downloadTemplate() {
    const headerRow = fields.map((f) => f.label);
    const example = kind === "client"
      ? ["Fresh Cafe Ltd", "Jane Doe", "+254712345678", "orders@freshcafe.co", "Weekly delivery Mondays", "12 Kimathi St, Nairobi"]
      : ["Kenya Fruits Co", "Peter Kim", "+254733222111", "sales@kenyafruits.co", "Oranges, mangoes"];
    const ws = XLSX.utils.aoa_to_sheet([headerRow, example]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, kind === "client" ? "Clients" : "Suppliers");
    XLSX.writeFile(wb, `${kind}s-import-template.xlsx`);
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
    const m: Partial<Record<FieldKey, string>> = {};
    for (const t of fields) {
      const found = hs.find((h) => guess(h, t.key));
      if (found) m[t.key] = found;
    }
    setMapping(m);
    setStep("map");
  }

  const previewRows = useMemo(
    () =>
      rows.slice(0, 5).map((r) => {
        const out: Record<string, unknown> = {};
        for (const t of fields) {
          const src = mapping[t.key];
          out[t.key] = src ? r[src] : "";
        }
        return out;
      }),
    [rows, mapping, fields],
  );

  const missingRequired = fields.filter((t) => t.required && !mapping[t.key]);

  async function doImport() {
    setImporting(true);
    const table = kind === "client" ? "clients" : "suppliers";
    let created = 0, updated = 0, failed = 0;
    const errors: string[] = [];

    for (const raw of rows) {
      const name = String(raw[mapping.name!] ?? "").trim();
      if (!name) { failed++; continue; }
      const payload: Record<string, string | null> = { name };
      for (const t of fields) {
        if (t.key === "name") continue;
        const src = mapping[t.key];
        payload[t.key] = src ? (String(raw[src] ?? "").trim() || null) : null;
      }
      // Upsert by name (case-insensitive)
      const { data: existing } = await supabase.from(table).select("id").ilike("name", name).maybeSingle();
      if (existing) {
        const { error } = await supabase.from(table).update(payload as never).eq("id", existing.id);
        if (error) { failed++; errors.push(`${name}: ${error.message}`); continue; }
        updated++;
      } else {
        const { error } = await supabase.from(table).insert(payload as never);
        if (error) { failed++; errors.push(`${name}: ${error.message}`); continue; }
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

  const title = kind === "client" ? "Bulk import clients" : "Bulk import suppliers";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>

        {step === "upload" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upload an Excel (.xlsx) or CSV file. Rows are matched by business name — existing records are updated in place.
            </p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={downloadTemplate}>
                <Download className="size-4 mr-2" /> Download template
              </Button>
              <Button onClick={() => fileInput.current?.click()} className="bg-brand-orange text-white hover:bg-brand-orange/90">
                <Upload className="size-4 mr-2" /> Choose file
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx,.xls,.csv"
                hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
              />
            </div>
          </div>
        )}

        {step === "map" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Match your columns. Required fields marked with *.</p>
            <div className="grid grid-cols-2 gap-3 max-h-80 overflow-auto pr-2">
              {fields.map((t) => (
                <div key={t.key}>
                  <Label>{t.label} {t.required && <span className="text-brand-orange">*</span>}</Label>
                  <Select
                    value={mapping[t.key] ?? "__none__"}
                    onValueChange={(v) => setMapping((m) => ({ ...m, [t.key]: v === "__none__" ? undefined : v }))}
                  >
                    <SelectTrigger><SelectValue placeholder="— none —" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— none —</SelectItem>
                      {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {missingRequired.length > 0 && (
              <p className="text-xs text-brand-orange">Missing required: {missingRequired.map((m) => m.label).join(", ")}</p>
            )}
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">First 5 rows shown. {rows.length} total rows will be imported.</p>
            <div className="border rounded-md overflow-auto max-h-80">
              <Table>
                <TableHeader>
                  <TableRow>{fields.map((t) => <TableHead key={t.key}>{t.label}</TableHead>)}</TableRow>
                </TableHeader>
                <TableBody>
                  {previewRows.map((r, i) => (
                    <TableRow key={i}>
                      {fields.map((t) => (
                        <TableCell key={t.key} className="text-xs whitespace-nowrap">{String(r[t.key] ?? "")}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
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
              <Button variant="outline" onClick={() => setStep("map")}>← Back</Button>
              <Button onClick={doImport} disabled={importing} className="bg-brand-orange text-white hover:bg-brand-orange/90">
                {importing ? "Importing…" : `Import ${rows.length} rows`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
