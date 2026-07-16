import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/notifications")({
  component: NotificationsPage,
});

interface Notif {
  id: string;
  title: string;
  body: string | null;
  level: "info" | "warn" | "critical";
  link: string | null;
  read_at: string | null;
  created_at: string;
}

function NotificationsPage() {
  const [items, setItems] = useState<Notif[]>([]);
  const navigate = useNavigate();

  async function load() {
    const { data } = await supabase
      .from("notifications")
      .select("id, title, body, level, link, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    setItems((data ?? []) as unknown as Notif[]);
  }

  useEffect(() => {
    load();
  }, []);

  async function markRead(id: string) {
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", id);
    setItems((prev) =>
      prev.map((p) => (p.id === id ? { ...p, read_at: new Date().toISOString() } : p)),
    );
  }

  async function markAllRead() {
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null);
    load();
  }

  const unread = items.filter((n) => !n.read_at).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        {unread > 0 && (
          <button
            onClick={markAllRead}
            className="text-xs text-brand-orange font-medium hover:underline"
          >
            Mark all {unread} as read
          </button>
        )}
      </div>
      <div className="bg-card rounded-lg ring-1 ring-black/5 divide-y">
        {items.length === 0 && (
          <p className="p-8 text-sm text-muted-foreground text-center">No notifications</p>
        )}
        {items.map((n) => {
          const dot =
            n.level === "critical"
              ? "bg-brand-red"
              : n.level === "warn"
                ? "bg-brand-orange"
                : "bg-brand-green";
          return (
            <button
              key={n.id}
              type="button"
              onClick={async () => {
                if (!n.read_at) await markRead(n.id);
                if (n.link) navigate({ to: n.link });
              }}
              className={cn(
                "p-4 flex gap-3 w-full text-left transition-colors hover:bg-muted/60",
                !n.read_at && "bg-muted/40",
              )}
            >
              <div className={cn("mt-1.5 size-2 rounded-full shrink-0", dot)} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{n.title}</p>
                {n.body && (
                  <p className="text-sm text-muted-foreground mt-0.5">{n.body}</p>
                )}
                <div className="flex items-center gap-3 mt-1">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
                    {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                  </p>
                  {n.link && (
                    <span className="text-[11px] text-brand-orange font-medium">
                      Open →
                    </span>
                  )}
                  {!n.read_at && (
                    <span className="text-[11px] text-brand-red font-medium uppercase tracking-wider">
                      Unread
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
