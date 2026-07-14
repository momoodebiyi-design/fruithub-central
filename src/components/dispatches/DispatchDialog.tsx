import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Trash2, Upload, FileText } from "lucide-react";
import { toast } from "sonner";

interface ShopOpt { id: string; name: string }
interface ClientOpt { id: string; name: string }
interface ItemOpt { id: string; name: string; sku: string; unit: string; quantity: number }
interface Line { item_id: string; quantity: string }

type Destination = "shop" | "client";

export function DispatchDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [destination, setDestination] = useState<Destination>("shop");
  const [shops, setShops] = useState<ShopOpt[]>([]);
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [items, setItems] = useState<ItemOpt[]>([]);
  const [shopId, setShopId] = useState<string>("");
  const [clientId, setClientId] = useState<string>("");
  const [reference, setReference] = useState(`DSP-${Date.now().toString(36).toUpperCase()}`);
  const [vehicle, setVehicle] = useState("");
  const [notes, setNotes] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [lines, setLines] = useState<Line[]>([{ item_id: "", quantity: "" }]);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      const [{ data: s }, { data: c }, { data: i }] = await Promise.all([
        supabase.from("shops").select("id, name").eq("is_active", true).order("name"),
        supabase.from("clients").select("id, name").eq("is_active", true).order("name"),
        supabase.from("inventory_items").select("id, name, sku, unit, quantity").eq("is_active", true).order("name"),
      ]);
      setShops((s as ShopOpt[]) ?? []);
      setClients((c as ClientOpt[]) ?? []);
      setItems((i as ItemOpt[]) ?? []);
    })();
  }, []);

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function save() {
    if (destination === "shop" && !shopId) return toast.error("Choose a shop");
    if (destination === "client" && !clientId) return toast.error("Choose a client");
    const valid = lines.filter((l) => l.item_id && Number(l.quantity) > 0);
    if (valid.length === 0) return toast.error("Add at least one line");
    setSaving(true);

    let invoiceUrl: string | null = null;
    if (invoiceFile) {
      const ext = invoiceFile.name.split(".").pop() ?? "pdf";
      const path = `${new Date().getFullYear()}/${reference.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("dispatch-invoices").upload(path, invoiceFile, {
        contentType: invoiceFile.type || "application/octet-stream",
        upsert: false,
      });
      if (upErr) {
        setSaving(false);
        return toast.error(`Invoice upload failed: ${upErr.message}`);
      }
      invoiceUrl = path;
    }

    const { error } = await supabase.rpc("create_dispatch" as any, {
      _shop_id: destination === "shop" ? shopId : null,
      _client_id: destination === "client" ? clientId : null,
      _reference: reference.trim(),
      _vehicle: vehicle.trim() || null,
      _notes: notes.trim() || null,
      _invoice_url: invoiceUrl,
      _invoice_number: invoiceNumber.trim() || null,
      _lines: valid.map((l) => ({ item_id: l.item_id, quantity: Number(l.quantity) })),
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
                  <SelectTrigger><SelectValue placeholder="Select shop" /></SelectTrigger>
                  <SelectContent>
                    {shops.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <Select value={clientId} onValueChange={setClientId}>
                  <SelectTrigger><SelectValue placeholder="Select client" /></SelectTrigger>
                  <SelectContent>
                    {clients.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div>
              <Label>Reference</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Vehicle</Label>
              <Input value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <Label>Notes</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
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
                    <><FileText className="size-4 mr-2" /> {invoiceFile.name}</>
                  ) : (
                    <><Upload className="size-4 mr-2" /> Attach invoice</>
                  )}
                </Button>
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Items</Label>
              <Button size="sm" variant="ghost" onClick={() => setLines([...lines, { item_id: "", quantity: "" }])}>
                <Plus className="size-3 mr-1" /> Add line
              </Button>
            </div>
            <div className="space-y-2">
              {lines.map((line, idx) => {
                const item = items.find((i) => i.id === line.item_id);
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <Select value={line.item_id} onValueChange={(v) => updateLine(idx, { item_id: v })}>
                      <SelectTrigger className="flex-1"><SelectValue placeholder="Item" /></SelectTrigger>
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
                    <Button size="icon" variant="ghost" onClick={() => setLines(lines.filter((_, i) => i !== idx))}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            {saving ? "Recording…" : "Record dispatch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
