import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Building2, Pencil } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { CAN_MANAGE_CLIENTS, hasAny } from "@/lib/permissions";
import { ClientDialog, type Client } from "@/components/clients/ClientDialog";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/clients")({
  component: ClientsPage,
});

interface ClientRow extends Client {
  id: string;
  is_active: boolean;
}

function ClientsPage() {
  const session = useSession();
  const canManage = hasAny(session.roles, CAN_MANAGE_CLIENTS);
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Client | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.from("clients").select("*").order("name");
    if (error) toast.error(error.message);
    setRows((data as ClientRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bulk clients</h1>
          <p className="text-sm text-muted-foreground">Businesses you supply in bulk. Dispatches to a client attach an invoice from your invoicing app.</p>
        </div>
        {canManage && (
          <Button onClick={() => { setEditing(null); setOpen(true); }} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            <Plus className="size-4 mr-2" /> New client
          </Button>
        )}
      </div>

      <div className="rounded-lg border overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground tracking-wider">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Client</th>
              <th className="text-left px-4 py-2 font-medium">Contact</th>
              <th className="text-left px-4 py-2 font-medium">Phone / Email</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="w-16" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                  <Building2 className="mx-auto size-8 mb-2 opacity-50" />
                  No bulk clients yet.
                </td>
              </tr>
            ) : rows.map((c) => (
              <tr key={c.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">{c.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.contact_name ?? "—"}</td>
                <td className="px-4 py-3 text-muted-foreground">
                  {[c.phone, c.email].filter(Boolean).join(" · ") || "—"}
                </td>
                <td className="px-4 py-3">
                  {c.is_active ? (
                    <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50">Active</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>
                  )}
                </td>
                <td className="px-4 py-3">
                  {canManage && (
                    <Button variant="ghost" size="icon" onClick={() => { setEditing(c); setOpen(true); }}>
                      <Pencil className="size-4" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && <ClientDialog client={editing} onClose={() => setOpen(false)} onSaved={load} />}
    </div>
  );
}
