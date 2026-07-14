import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export interface Client {
  id?: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  is_active?: boolean;
}

export function ClientDialog({
  client,
  onClose,
  onSaved,
}: {
  client: Client | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!client?.id;
  const [form, setForm] = useState<Client>(
    client ?? { name: "", contact_name: null, phone: null, email: null, address: null, notes: null, is_active: true },
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (client) setForm(client);
  }, [client]);

  async function save() {
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      contact_name: form.contact_name,
      phone: form.phone,
      email: form.email,
      address: form.address,
      notes: form.notes,
      is_active: form.is_active ?? true,
    };
    const { error } = editing
      ? await supabase.from("clients").update(payload).eq("id", client!.id!)
      : await supabase.from("clients").insert(payload);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(editing ? "Client updated" : "Client created");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit client" : "New bulk client"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Business name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Contact person</Label>
              <Input value={form.contact_name ?? ""} onChange={(e) => setForm({ ...form, contact_name: e.target.value || null })} />
            </div>
            <div>
              <Label>Phone</Label>
              <Input value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value || null })} />
            </div>
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" value={form.email ?? ""} onChange={(e) => setForm({ ...form, email: e.target.value || null })} />
          </div>
          <div>
            <Label>Address</Label>
            <Input value={form.address ?? ""} onChange={(e) => setForm({ ...form, address: e.target.value || null })} />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea rows={3} value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value || null })} />
          </div>
          {editing && (
            <div className="flex items-center justify-between">
              <Label htmlFor="client-active">Active</Label>
              <Switch id="client-active" checked={form.is_active ?? true} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
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
