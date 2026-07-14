import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Boxes, FlaskConical, LayoutDashboard, Truck, Users, BarChart3 } from "lucide-react";

interface ItemHit {
  id: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
}

interface BatchHit {
  id: string;
  batch_number: string;
  quantity_produced: number;
}

interface SupplierHit {
  id: string;
  name: string;
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ItemHit[]>([]);
  const [batches, setBatches] = useState<BatchHit[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierHit[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      const term = q.trim();
      if (!term) {
        const { data } = await supabase
          .from("inventory_items")
          .select("id, sku, name, unit, quantity")
          .order("updated_at", { ascending: false })
          .limit(8);
        if (!cancelled) {
          setItems((data ?? []) as ItemHit[]);
          setBatches([]);
          setSuppliers([]);
        }
        return;
      }
      const like = `%${term}%`;
      const [it, bt, sp] = await Promise.all([
        supabase
          .from("inventory_items")
          .select("id, sku, name, unit, quantity")
          .or(`name.ilike.${like},sku.ilike.${like}`)
          .limit(8),
        supabase
          .from("production_batches")
          .select("id, batch_number, quantity_produced")
          .ilike("batch_number", like)
          .limit(5),
        supabase.from("suppliers").select("id, name").ilike("name", like).limit(5),
      ]);
      if (!cancelled) {
        setItems((it.data ?? []) as ItemHit[]);
        setBatches((bt.data ?? []) as BatchHit[]);
        setSuppliers((sp.data ?? []) as SupplierHit[]);
      }
    };
    const t = setTimeout(run, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open]);

  function go(to: string) {
    onOpenChange(false);
    setQ("");
    navigate({ to });
  }

  const NAV = [
    { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { to: "/inventory", label: "Inventory", icon: Boxes },
    { to: "/production", label: "Production", icon: FlaskConical },
    { to: "/procurement", label: "Procurement", icon: Truck },
    { to: "/reports", label: "Reports", icon: BarChart3 },
    { to: "/users", label: "Users", icon: Users },
  ];

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        value={q}
        onValueChange={setQ}
        placeholder="Search inventory, batches, suppliers…"
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        {items.length > 0 && (
          <CommandGroup heading="Inventory">
            {items.map((it) => (
              <CommandItem
                key={it.id}
                value={`item ${it.sku} ${it.name}`}
                onSelect={() => go(`/inventory/${it.id}`)}
              >
                <Boxes className="size-4 mr-2 text-muted-foreground" />
                <div className="flex-1">
                  <p className="text-sm">{it.name}</p>
                  <p className="text-[10px] font-mono text-muted-foreground">{it.sku}</p>
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  {Number(it.quantity).toLocaleString()} {it.unit}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {batches.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Production batches">
              {batches.map((b) => (
                <CommandItem
                  key={b.id}
                  value={`batch ${b.batch_number}`}
                  onSelect={() => go("/production")}
                >
                  <FlaskConical className="size-4 mr-2 text-muted-foreground" />
                  <span className="font-mono text-sm">{b.batch_number}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {Number(b.quantity_produced).toLocaleString()}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {suppliers.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Suppliers">
              {suppliers.map((s) => (
                <CommandItem
                  key={s.id}
                  value={`supplier ${s.name}`}
                  onSelect={() => go("/procurement")}
                >
                  <Truck className="size-4 mr-2 text-muted-foreground" />
                  {s.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Go to">
          {NAV.map((n) => {
            const Icon = n.icon;
            return (
              <CommandItem key={n.to} value={`nav ${n.label}`} onSelect={() => go(n.to)}>
                <Icon className="size-4 mr-2 text-muted-foreground" />
                {n.label}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
