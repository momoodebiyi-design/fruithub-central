import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export interface Shop {
  id?: string;
  name: string;
  location: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  notes: string | null;
  is_active?: boolean;
}

export function ShopDialog({
  shop,
  onClose,
  onSaved,
}: {
  shop: Shop | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!shop?.id;
  const [form, setForm] = useState<Shop>(
    shop ?? { name: "", location: null, contact_phone: null, contact_email: null, notes: null, is_active: true },
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (shop) setForm(shop);
  }, [shop]);

  async function save() {
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      location: form.location,
      contact_phone: form.contact_phone,
      contact_email: form.contact_email,
      notes: form.notes,
      is_active: form.is_active ?? true,
    };
    const { error } = editing
      ? await supabase.from("shops").update(payload).eq("id", shop!.id!)
      : await supabase.from("shops").insert(payload);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(editing ? "Shop updated" : "Shop created");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit shop" : "New shop"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Downtown outlet" />
          </div>
          <div>
            <Label>Location</Label>
            <Input value={form.location ?? ""} onChange={(e) => setForm({ ...form, location: e.target.value || null })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Phone</Label>
              <Input value={form.contact_phone ?? ""} onChange={(e) => setForm({ ...form, contact_phone: e.target.value || null })} />
            </div>
            <div>
              <Label>Email</Label>
              <Input type="email" value={form.contact_email ?? ""} onChange={(e) => setForm({ ...form, contact_email: e.target.value || null })} />
            </div>
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea rows={3} value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value || null })} />
          </div>
          {editing && (
            <div className="flex items-center justify-between">
              <Label htmlFor="shop-active">Active</Label>
              <Switch id="shop-active" checked={form.is_active ?? true} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || !form.name.trim()} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
