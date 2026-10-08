/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Trash2, Upload, FileText } from "lucide-react";
import { toast } from "sonner";

interface ShopOpt {
  id: string;
  name: string;
}
interface ClientOpt {
  id: string;
  name: string;
}
interface ItemOpt {
  id: string;
  name: string;
  sku: string;
  unit: string;
  quantity: number;
}
interface Line {
  item_id: string;
  quantity: string;
}

type Destination = "shop" | "client";

type CrossedStocktake = {
  item_id: string;
  stocktake_id: string;
  count_number: string;
  submitted_at: string | null;
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

function dispatchTimeUtc(value: string) {
  if (!value) return null;
  const parsed = new Date(`${value}:00+01:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function DispatchDialog({
  onClose,
  onSaved,
  canBackdate,
}: {
  onClose: () => void;
  onSaved: () => void;
  canBackdate: boolean;
}) {
  const [destination, setDestination] = useState<Destination>("shop");
  const [shops, setShops] = useState<ShopOpt[]>([]);
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [items, setItems] = useState<ItemOpt[]>([]);
  const [shopId, setShopId] = useState<string>("");
  const [clientId, setClientId] = useState<string>("");
  const [reference, setReference] = useState(`DSP-${Date.now().toString(36).toUpperCase()}`);
  const [vehicle, setVehicle] = useState("");
  const [notes, setNotes] = useState("");
  const [dispatchedLocal, setDispatchedLocal] = useState(lagosDateTimeInput);
  const [lateEntryReason, setLateEntryReason] = useState("");
  const [stocktakeTreatment, setStocktakeTreatment] = useState("");
  const [crossedStocktakes, setCrossedStocktakes] = useState<CrossedStocktake[]>([]);
  const [stocktakeCheck, setStocktakeCheck] = useState<"loading" | "ready" | "error">("ready");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [lines, setLines] = useState<Line[]>([{ item_id: "", quantity: "" }]);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const todayInLagos = lagosDateTimeInput().slice(0, 10);
  const isBackdated = dispatchedLocal.slice(0, 10) < todayInLagos;
  const selectedItemIds = [...new Set(lines.map((line) => line.item_id).filter(Boolean))];
  const selectedItemKey = selectedItemIds.sort().join(",");
  const actualDispatchAt = dispatchTimeUtc(dispatchedLocal);

  useEffect(() => {
    (async () => {
      const [{ data: s }, { data: c }, { data: i }] = await Promise.all([
        supabase.from("shops").select("id, name").eq("is_active", true).order("name"),
        supabase.from("clients").select("id, name").eq("is_active", true).order("name"),
        (supabase as any)
          .from("v_central_item_stock")
          .select("item_id, name, sku, unit, on_hand")
          .eq("status", "active")
          .order("name"),
      ]);
      setShops((s as ShopOpt[]) ?? []);
      setClients((c as ClientOpt[]) ?? []);
      setItems(
        ((i as any[]) ?? []).map((r) => ({
          id: r.item_id,
          name: r.name,
          sku: r.sku,
          unit: r.unit,
          quantity: Number(r.on_hand ?? 0),
        })),
      );
    })();
  }, []);

  useEffect(() => {
    if (!canBackdate || !actualDispatchAt || !selectedItemKey) {
      setCrossedStocktakes([]);
      setStocktakeCheck("ready");
      return;
    }
    let cancelled = false;
    setStocktakeCheck("loading");
    const timer = window.setTimeout(async () => {
      const { data, error } = await supabase.rpc("preview_backdated_dispatch_stocktakes", {
        _dispatched_at: actualDispatchAt,
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
  }, [actualDispatchAt, canBackdate, selectedItemKey]);

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function save() {
    if (destination === "shop" && !shopId) return toast.error("Choose a shop");
    if (destination === "client" && !clientId) return toast.error("Choose a client");
    const valid = lines.filter((l) => l.item_id && Number(l.quantity) > 0);
    if (valid.length === 0) return toast.error("Add at least one line");
    if (!actualDispatchAt || new Date(actualDispatchAt).getTime() > Date.now() + 5 * 60_000) {
      return toast.error("Choose a dispatch date and time that is not in the future");
    }
    if (isBackdated && !canBackdate) {
      return toast.error("Only Management or Admin can record a previous-day dispatch");
    }
    if (isBackdated && lateEntryReason.trim().length < 5) {
      return toast.error("Explain why this dispatch is being recorded late");
    }
    if (canBackdate && stocktakeCheck !== "ready") {
      return toast.error("Wait for the Central stocktake check to complete");
    }
    if (crossedStocktakes.length > 0 && !stocktakeTreatment) {
      return toast.error("Choose how the later Central stocktake affects stock");
    }
    setSaving(true);

    let invoiceUrl: string | null = null;
    if (invoiceFile) {
      const ext = invoiceFile.name.split(".").pop() ?? "pdf";
      const path = `${new Date().getFullYear()}/${reference.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("dispatch-invoices")
        .upload(path, invoiceFile, {
          contentType: invoiceFile.type || "application/octet-stream",
          upsert: false,
        });
      if (upErr) {
        setSaving(false);
        return toast.error(`Invoice upload failed: ${upErr.message}`);
      }
      invoiceUrl = path;
    }

    const { error } = await supabase.rpc("create_dispatch_with_date", {
      _shop_id: destination === "shop" ? shopId : null,
      _client_id: destination === "client" ? clientId : null,
      _reference: reference.trim(),
      _vehicle: vehicle.trim() || null,
      _notes: notes.trim() || null,
      _invoice_url: invoiceUrl,
      _invoice_number: invoiceNumber.trim() || null,
      _lines: valid.map((l) => ({ item_id: l.item_id, quantity: Number(l.quantity) })),
      _dispatched_at: actualDispatchAt,
      _late_entry_reason: isBackdated ? lateEntryReason.trim() : null,
      _stocktake_treatment: crossedStocktakes.length > 0 ? stocktakeTreatment : null,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Dispatch recorded");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New dispatch</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Tabs value={destination} onValueChange={(v) => setDestination(v as Destination)}>
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="shop">To a shop</TabsTrigger>
              <TabsTrigger value="client">To a bulk client</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{destination === "shop" ? "Shop" : "Client"}</Label>
              {destination === "shop" ? (
                <Select value={shopId} onValueChange={setShopId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select shop" />
                  </SelectTrigger>
                  <SelectContent>
                    {shops.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Select value={clientId} onValueChange={setClientId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select client" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div>
              <Label>Reference</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="dispatch-time">Date and time dispatched (Lagos time)</Label>
            <Input
              id="dispatch-time"
              type="datetime-local"
              value={dispatchedLocal}
              max={lagosDateTimeInput()}
              onChange={(event) => {
                setDispatchedLocal(event.target.value);
                setStocktakeTreatment("");
              }}
            />
            <p className="text-xs text-muted-foreground">
              The app separately records when you enter this dispatch.
              {!canBackdate && " Previous-day dates require Management or Admin."}
            </p>
          </div>

          {isBackdated && (
            <div className="space-y-2">
              <Label htmlFor="late-entry-reason">Reason for recording late</Label>
              <Input
                id="late-entry-reason"
                value={lateEntryReason}
                onChange={(event) => setLateEntryReason(event.target.value)}
                placeholder="For example: dispatch sheet was submitted the next morning"
              />
            </div>
          )}

          {canBackdate && selectedItemIds.length > 0 && stocktakeCheck === "loading" && (
            <p className="text-sm text-muted-foreground">Checking later Central stocktakes…</p>
          )}
          {canBackdate && stocktakeCheck === "error" && (
            <p className="text-sm text-destructive">
              Central stocktakes could not be checked. Change the dispatch time to retry.
            </p>
          )}
          {crossedStocktakes.length > 0 && (
            <div className="space-y-3 rounded-md border border-brand-orange/30 bg-brand-orange/5 p-3">
              <p className="text-sm font-medium">A later Central stocktake covers these items</p>
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
                    Already counted — do not deduct them again
                  </SelectItem>
                  <SelectItem value="deduct_now">
                    Not included in the count — deduct them now
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Items without a later stocktake will always be deducted. Your choice is saved in the
                audit log.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Vehicle</Label>
              <Input
                value={vehicle}
                onChange={(e) => setVehicle(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div>
              <Label>Notes</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>

          {destination === "client" && (
            <div className="grid grid-cols-2 gap-3 items-end">
              <div>
                <Label>Invoice number</Label>
                <Input
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  placeholder="INV-2026-001"
                />
              </div>
              <div>
                <Label>Invoice file (PDF)</Label>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf,image/*"
                  className="hidden"
                  onChange={(e) => setInvoiceFile(e.target.files?.[0] ?? null)}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => fileRef.current?.click()}
                >
                  {invoiceFile ? (
                    <>
                      <FileText className="size-4 mr-2" /> {invoiceFile.name}
                    </>
                  ) : (
                    <>
                      <Upload className="size-4 mr-2" /> Attach invoice
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Items</Label>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLines([...lines, { item_id: "", quantity: "" }])}
              >
                <Plus className="size-3 mr-1" /> Add line
              </Button>
            </div>
            <div className="space-y-2">
              {lines.map((line, idx) => {
                const item = items.find((i) => i.id === line.item_id);
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <Select
                      value={line.item_id}
                      onValueChange={(v) => updateLine(idx, { item_id: v })}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Item" />
                      </SelectTrigger>
                      <SelectContent>
                        {items.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.name} · {i.quantity} {i.unit} on hand
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      className="w-28 font-mono"
                      placeholder="Qty"
                      value={line.quantity}
                      onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                    />
                    <span className="w-10 text-xs text-muted-foreground">{item?.unit ?? ""}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setLines(lines.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving}
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            {saving ? "Recording…" : "Record dispatch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
