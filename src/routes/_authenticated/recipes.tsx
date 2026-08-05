/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Plus, Search, Pencil, CheckCircle2, Archive, Send } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { hasAny, CAN_MANAGE_RECIPES, CAN_APPROVE_RECIPES } from "@/lib/permissions";
import { RecipeDialog } from "@/components/recipes/RecipeDialog";
import { IngredientsDialog } from "@/components/recipes/IngredientsDialog";

export const Route = createFileRoute("/_authenticated/recipes")({
  component: RecipesPage,
});

interface RecipeRow {
  id: string;
  product_item_id: string;
  version: number;
  yield_quantity: number | null;
  yield_unit: string | null;
  waste_pct: number | null;
  status: "draft" | "pending_approval" | "approved" | "retired";
  notes: string | null;
  updated_at: string;
  product: { name: string; sku: string; unit: string; category: string } | null;
  ingredient_count: number;
}

function RecipesPage() {
  const { roles } = useSession();
  const canManage = hasAny(roles, CAN_MANAGE_RECIPES);
  const canApprove = hasAny(roles, CAN_APPROVE_RECIPES);

  const [rows, setRows] = useState<RecipeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editing, setEditing] = useState<RecipeRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [ingredientsFor, setIngredientsFor] = useState<RecipeRow | null>(null);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("recipes")
      .select(
        "id, product_item_id, version, yield_quantity, yield_unit, waste_pct, status, notes, updated_at, product:inventory_items!recipes_product_item_id_fkey(name, sku, unit, category), recipe_ingredients(count)",
      )
      .order("updated_at", { ascending: false });
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    const mapped = (data ?? []).map((r: any) => ({
      ...r,
      ingredient_count: r.recipe_ingredients?.[0]?.count ?? 0,
    })) as RecipeRow[];
    setRows(mapped);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = rows.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (!q) return true;
    const s = q.toLowerCase();
    return (
      r.product?.name.toLowerCase().includes(s) ||
      r.product?.sku.toLowerCase().includes(s) ||
      (r.notes ?? "").toLowerCase().includes(s)
    );
  });

  async function submitForApproval(id: string) {
    const { error } = await supabase
      .from("recipes")
      .update({ status: "pending_approval" })
      .eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Submitted for approval");
    load();
  }

  async function approve(id: string) {
    const { error } = await supabase.rpc("approve_recipe", { _recipe_id: id });
    if (error) return toast.error(error.message);
    toast.success("Packaging setup approved");
    load();
  }

  async function retire(id: string) {
    if (!confirm("Retire this packaging setup? It can no longer drive production deductions."))
      return;
    const { error } = await supabase.from("recipes").update({ status: "retired" }).eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Packaging setup retired");
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Packaging Setup</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Define only the bottles, caps, labels, nylons, spoons, serviettes and other consumables
            used for each finished product.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => setCreating(true)}
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            <Plus className="size-4 mr-1" /> New packaging setup
          </Button>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by product, SKU, notes…"
            className="pl-9"
          />
        </div>
        <div className="flex gap-1 border rounded-md p-1 bg-card">
          {(["all", "draft", "pending_approval", "approved", "retired"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 text-xs rounded ${
                statusFilter === s
                  ? "bg-brand-orange text-white"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b">
              <th className="p-3 font-medium">Product</th>
              <th className="p-3 font-medium">Version</th>
              <th className="p-3 font-medium">Packaging items</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="p-8 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-8 text-center text-muted-foreground">
                  No packaging setups yet.
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.id} className="border-b last:border-b-0 hover:bg-muted/40">
                  <td className="p-3">
                    <div className="font-medium">{r.product?.name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground font-mono">{r.product?.sku}</div>
                  </td>
                  <td className="p-3 font-mono">v{r.version}</td>
                  <td className="p-3 font-mono">{r.ingredient_count}</td>
                  <td className="p-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1 flex-wrap">
                      <Button variant="ghost" size="sm" onClick={() => setIngredientsFor(r)}>
                        Packaging items
                      </Button>
                      {canManage && r.status !== "retired" && (
                        <Button variant="ghost" size="sm" onClick={() => setEditing(r)}>
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                      {canManage && r.status === "draft" && r.ingredient_count > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => submitForApproval(r.id)}
                          title="Submit for approval"
                        >
                          <Send className="size-3.5" />
                        </Button>
                      )}
                      {canApprove && r.status === "pending_approval" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => approve(r.id)}
                          className="text-emerald-600"
                          title="Approve"
                        >
                          <CheckCircle2 className="size-3.5" />
                        </Button>
                      )}
                      {canManage && r.status === "approved" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => retire(r.id)}
                          className="text-muted-foreground"
                          title="Retire"
                        >
                          <Archive className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <RecipeDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      )}
      {editing && (
        <RecipeDialog
          recipe={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {ingredientsFor && (
        <IngredientsDialog
          recipe={ingredientsFor}
          canEdit={
            canManage && ingredientsFor.status !== "retired" && ingredientsFor.status !== "approved"
          }
          onClose={() => setIngredientsFor(null)}
          onSaved={() => {
            load();
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: RecipeRow["status"] }) {
  const map: Record<RecipeRow["status"], { label: string; className: string }> = {
    draft: { label: "Draft", className: "bg-muted text-foreground" },
    pending_approval: {
      label: "Pending approval",
      className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    },
    approved: {
      label: "Approved",
      className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
    },
    retired: {
      label: "Retired",
      className: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    },
  };
  const c = map[status];
  return <Badge className={`${c.className} border-0 font-normal`}>{c.label}</Badge>;
}
