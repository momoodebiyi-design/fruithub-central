import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Plus, Truck, Pencil, Upload } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { hasAny, type AppRole } from "@/lib/permissions";
import { SupplierDialog, type Supplier } from "@/components/suppliers/SupplierDialog";
import { ContactsImportDialog } from "@/components/shared/ContactsImportDialog";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/suppliers")({
  component: SuppliersPage,
});

const CAN_MANAGE_SUPPLIERS: AppRole[] = [
  "super_admin", "admin", "management", "operations_manager", "procurement", "inventory_officer",
];

interface SupplierRow extends Supplier { id: string }

function SuppliersPage() {
  const session = useSession();
  const canManage = hasAny(session.roles, CAN_MANAGE_SUPPLIERS);
  const [rows, setRows] = useState<SupplierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.from("suppliers").select("*").order("name");
    if (error) toast.error(error.message);
    setRows((data as SupplierRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
          <p className="text-sm text-muted-foreground">Businesses you buy raw materials, packaging, or consumables from.</p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImporting(true)}>
              <Upload className="size-4 mr-2" /> Import
            </Button>
            <Button onClick={() => { setEditing(null); setOpen(true); }} className="bg-brand-orange text-white hover:bg-brand-orange/90">
              <Plus className="size-4 mr-2" /> New supplier
            </Button>
          </div>
        )}
      </div>

      <div className="rounded-lg border overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground tracking-wider">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Supplier</th>
              <th className="text-left px-4 py-2 font-medium">Contact</th>
              <th className="text-left px-4 py-2 font-medium">Phone / Email</th>
              <th className="w-16" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                  <Truck className="mx-auto size-8 mb-2 opacity-50" />
                  No suppliers yet.
                </td>
              </tr>
            ) : rows.map((s) => (
              <tr key={s.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">{s.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{s.contact_name ?? "—"}</td>
                <td className="px-4 py-3 text-muted-foreground">
                  {[s.phone, s.email].filter(Boolean).join(" · ") || "—"}
                </td>
                <td className="px-4 py-3">
                  {canManage && (
                    <Button variant="ghost" size="icon" onClick={() => { setEditing(s); setOpen(true); }}>
                      <Pencil className="size-4" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && <SupplierDialog supplier={editing} onClose={() => setOpen(false)} onSaved={load} />}
      {importing && <ContactsImportDialog kind="supplier" onClose={() => setImporting(false)} onImported={load} />}
    </div>
  );
}
