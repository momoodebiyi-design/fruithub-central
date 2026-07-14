import { createFileRoute } from "@tanstack/react-router";
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
  read_at: string | null;
  created_at: string;
}

function NotificationsPage() {
  const [items, setItems] = useState<Notif[]>([]);

  async function load() {
    const { data } = await supabase
      .from("notifications")
      .select("id, title, body, level, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    setItems((data ?? []) as unknown as Notif[]);
  }

  useEffect(() => {
    load();
    // mark all as read on open
    (async () => {
      await supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
    })();
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
      <div className="bg-card rounded-lg ring-1 ring-black/5 divide-y">
        {items.length === 0 && <p className="p-8 text-sm text-muted-foreground text-center">No notifications</p>}
        {items.map((n) => {
          const dot = n.level === "critical" ? "bg-brand-red" : n.level === "warn" ? "bg-brand-orange" : "bg-brand-green";
          return (
            <div key={n.id} className="p-4 flex gap-3">
              <div className={cn("mt-1.5 size-2 rounded-full shrink-0", dot)} />
              <div className="flex-1">
                <p className="text-sm font-medium">{n.title}</p>
                {n.body && <p className="text-sm text-muted-foreground mt-0.5">{n.body}</p>}
                <p className="text-[11px] text-muted-foreground mt-1 uppercase tracking-wider">
                  {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
