import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Store, Pencil, ListChecks } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { CAN_MANAGE_ASSORTMENT, CAN_MANAGE_SHOPS, hasAny } from "@/lib/permissions";
import { ShopDialog, type Shop } from "@/components/shops/ShopDialog";
import { AssortmentDialog } from "@/components/shops/AssortmentDialog";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/shops")({
  component: ShopsPage,
});

interface ShopRow extends Shop {
  id: string;
  is_active: boolean;
}

function ShopsPage() {
  const session = useSession();
  const canManage = hasAny(session.roles, CAN_MANAGE_SHOPS);
  const canAssort = hasAny(session.roles, CAN_MANAGE_ASSORTMENT);
  const [rows, setRows] = useState<ShopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Shop | null>(null);
  const [open, setOpen] = useState(false);
  const [assortFor, setAssortFor] = useState<{ id: string; name: string } | null>(null);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("shops")
      .select("*")
      .order("name");
    if (error) toast.error(error.message);
    setRows((data as ShopRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Shops</h1>
          <p className="text-sm text-muted-foreground">Retail outlets you dispatch stock to.</p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            <Plus className="size-4 mr-2" />
            New shop
          </Button>
        )}
      </div>

      <div className="rounded-lg border overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground tracking-wider">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Shop</th>
              <th className="text-left px-4 py-2 font-medium">Location</th>
              <th className="text-left px-4 py-2 font-medium">Contact</th>
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
                  <Store className="mx-auto size-8 mb-2 opacity-50" />
                  No shops yet.
                </td>
              </tr>
            ) : (
              rows.map((s) => (
                <tr key={s.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{s.location ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {[s.contact_phone, s.contact_email].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="px-4 py-3">
                    {s.is_active ? (
                      <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {canAssort && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAssortFor({ id: s.id, name: s.name })}
                      >
                        <ListChecks className="size-4 mr-1" /> Assortment
                      </Button>
                    )}
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setEditing(s);
                          setOpen(true);
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <ShopDialog
          shop={editing}
          onClose={() => setOpen(false)}
          onSaved={load}
        />
      )}
      {assortFor && (
        <AssortmentDialog
          shopId={assortFor.id}
          shopName={assortFor.name}
          onClose={() => setAssortFor(null)}
        />
      )}
    </div>
  );
}
