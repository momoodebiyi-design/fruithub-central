import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Boxes,
  FlaskConical,
  Store,
  Send,
  ClipboardList,
  ClipboardCheck,
  Users,
  Building2,
  PackageSearch,
  ShoppingCart,
  Search,
  LogOut,
  Menu,
  X,
  ShieldCheck,
  Lock,
  ChartNoAxesCombined,
  ScanLine,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import {
  CAN_MANAGE_USERS,
  CAN_VIEW_AUDIT,
  CAN_MANAGE_CLIENTS,
  CAN_MANAGE_RECIPES,
  CAN_RECORD_PRODUCTION,
  CAN_DISPATCH,
  CAN_MANAGE_SHOPS,
  CAN_MANAGE_PURCHASES,
  CAN_VIEW_PURCHASING,
  CAN_VIEW_REPORTS,
  hasAny,
  isShopSupervisorOnly,
  ROLE_LABELS,
  type AppRole,
} from "@/lib/permissions";
import { NotificationsBell } from "@/components/NotificationsBell";
import { CommandPalette } from "@/components/CommandPalette";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  roles?: AppRole[];
};

type DisabledItem = {
  label: string;
  icon: typeof LayoutDashboard;
  hint: string;
};

// Scope-controlled nav: placeholder / not-yet-built modules
// (Sales orders and separate Procurement modules) are intentionally omitted.
// See .lovable/architecture.md for the roadmap.
const FULL_NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/inventory", label: "Central Stock", icon: Boxes },
  { to: "/recipes", label: "Packaging Setup", icon: FlaskConical, roles: CAN_MANAGE_RECIPES },
  { to: "/production", label: "Production", icon: FlaskConical, roles: CAN_RECORD_PRODUCTION },
  { to: "/stocktakes", label: "Central Stocktake", icon: ScanLine, roles: CAN_WRITE_INVENTORY },
  { to: "/dispatches", label: "Transfers / Dispatches", icon: Send, roles: CAN_DISPATCH },
  { to: "/shops", label: "Shops", icon: Store, roles: CAN_MANAGE_SHOPS },
  { to: "/purchasing", label: "Purchasing", icon: ShoppingCart, roles: CAN_VIEW_PURCHASING },
  { to: "/reports", label: "Reports", icon: ChartNoAxesCombined, roles: CAN_VIEW_REPORTS },
];

const SUPERVISOR_NAV: NavItem[] = [{ to: "/dashboard", label: "Today", icon: LayoutDashboard }];

const SUPERVISOR_UPCOMING: DisabledItem[] = [
  { label: "Shop stock tools", icon: Lock, hint: "Paused until POS rollout" },
  { label: "Sales / POS", icon: Send, hint: "Planned for a later release" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const supervisorOnly = isShopSupervisorOnly(session.roles);
  const canManageUsers = hasAny(session.roles, CAN_MANAGE_USERS);
  const canViewAudit = hasAny(session.roles, CAN_VIEW_AUDIT);
  const canManageClients = hasAny(session.roles, CAN_MANAGE_CLIENTS);
  const canViewSuppliers = hasAny(session.roles, CAN_MANAGE_PURCHASES);

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const items: NavItem[] = supervisorOnly
    ? SUPERVISOR_NAV
    : [
        ...FULL_NAV.filter((n) => !n.roles || hasAny(session.roles, n.roles)),
        ...(canManageClients
          ? [{ to: "/clients", label: "Bulk clients", icon: Building2 } as NavItem]
          : []),
        ...(canViewSuppliers
          ? [{ to: "/suppliers", label: "Suppliers", icon: PackageSearch } as NavItem]
          : []),
        ...(canManageUsers ? [{ to: "/users", label: "Users", icon: Users } as NavItem] : []),
        ...(canViewAudit
          ? [{ to: "/audit", label: "Audit Log", icon: ShieldCheck } as NavItem]
          : []),
      ];

  const primaryRole = session.roles[0];

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-64 shrink-0 border-r bg-sidebar flex flex-col transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border">
          <div className="size-6 rounded-md bg-brand-orange ring-1 ring-black/10 flex items-center justify-center">
            <div className="size-2 bg-white rounded-full opacity-80" />
          </div>
          <span className="ml-3 text-sm font-semibold tracking-tight">Juicery Ops</span>
          <button
            className="ml-auto lg:hidden text-muted-foreground"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          >
            <X className="size-5" />
          </button>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {supervisorOnly && (
            <p className="px-3 pt-1 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              Shop operations paused
            </p>
          )}
          {items.map((item) => {
            const active = pathname === item.to || pathname.startsWith(item.to + "/");
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/60",
                )}
              >
                <Icon
                  className={cn(
                    "size-4 flex-shrink-0",
                    active ? "text-brand-orange" : "text-muted-foreground",
                  )}
                />
                {item.label}
              </Link>
            );
          })}
          {supervisorOnly &&
            SUPERVISOR_UPCOMING.map((u) => {
              const Icon = u.icon;
              return (
                <span
                  key={u.label}
                  title={u.hint}
                  className="flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md text-muted-foreground/50 cursor-not-allowed select-none"
                >
                  <Icon className="size-4 flex-shrink-0 opacity-60" />
                  <span className="flex-1">{u.label}</span>
                  <span className="text-[9px] uppercase tracking-wider border border-current/30 rounded px-1 py-0.5">
                    soon
                  </span>
                </span>
              );
            })}
        </nav>

        <div className="p-4 border-t border-sidebar-border">
          <Link
            to="/settings/profile"
            onClick={() => setMobileOpen(false)}
            className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-sidebar-accent/60"
          >
            <div className="size-8 rounded-full bg-muted ring-1 ring-black/5 flex items-center justify-center text-xs font-semibold">
              {(session.fullName ?? session.user?.email ?? "?").slice(0, 1).toUpperCase()}
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-xs font-medium truncate">
                {session.fullName ?? session.user?.email ?? "—"}
              </span>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider truncate">
                {primaryRole ? ROLE_LABELS[primaryRole] : "No role"}
              </span>
            </div>
          </Link>
        </div>
      </aside>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b bg-background/80 backdrop-blur-sm sticky top-0 z-20 flex items-center justify-between px-4 lg:px-8 gap-4">
          <button
            className="lg:hidden text-muted-foreground"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </button>

          {!supervisorOnly && (
            <div className="flex-1 max-w-xl relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="w-full pl-9 pr-16 py-1.5 bg-muted rounded-md text-sm text-left text-muted-foreground/80 hover:bg-muted/70 outline-none focus:ring-1 focus:ring-brand-orange/40"
              >
                Search inventory, batches, suppliers…
                <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono bg-background/80 border rounded px-1.5 py-0.5">
                  ⌘K
                </kbd>
              </button>
            </div>
          )}
          {supervisorOnly && <div className="flex-1" />}

          <div className="flex items-center gap-3">
            <NotificationsBell />
            <Button variant="ghost" size="icon" onClick={signOut} title="Sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <div className="max-w-7xl mx-auto w-full">{children}</div>
        </main>
      </div>
      {!supervisorOnly && <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />}
    </div>
  );
}
