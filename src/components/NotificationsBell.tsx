import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

interface Notification {
  id: string;
  title: string;
  body: string | null;
  level: "info" | "warn" | "critical";
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export function NotificationsBell() {
  const [items, setItems] = useState<Notification[]>([]);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const { data } = await supabase
        .from("notifications")
        .select("id, title, body, level, link, read_at, created_at")
        .order("created_at", { ascending: false })
        .limit(15);
      if (mounted && data) setItems(data as Notification[]);
    }
    load();

    const channel = supabase
      .channel("notifications-bell")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        () => load(),
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const unread = items.filter((n) => !n.read_at).length;

  async function markAllRead() {
    const ids = items.filter((n) => !n.read_at).map((n) => n.id);
    if (!ids.length) return;
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute top-1 right-1 size-2 rounded-full bg-brand-red ring-2 ring-background" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h4 className="text-sm font-semibold">Notifications</h4>
          <button
            onClick={markAllRead}
            className="text-[11px] text-brand-orange font-medium disabled:opacity-40"
            disabled={unread === 0}
          >
            Mark all read
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto divide-y">
          {items.length === 0 && (
            <p className="p-6 text-sm text-muted-foreground text-center">No notifications yet</p>
          )}
          {items.map((n) => (
            <NotificationRow key={n.id} n={n} />
          ))}
        </div>
        <div className="border-t px-4 py-2 text-center">
          <Link to="/notifications" className="text-xs text-muted-foreground hover:text-foreground">
            View all
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NotificationRow({ n }: { n: Notification }) {
  const navigate = useNavigate();
  const dot =
    n.level === "critical"
      ? "bg-brand-red"
      : n.level === "warn"
        ? "bg-brand-orange"
        : "bg-brand-green";

  async function handleClick() {
    if (!n.read_at) {
      await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", n.id);
    }
    if (n.link) {
      navigate({ to: n.link });
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "px-4 py-3 flex gap-3 w-full text-left transition-colors hover:bg-muted/60",
        !n.read_at && "bg-muted/40",
        n.link && "cursor-pointer",
      )}
    >
      <div className={cn("mt-1.5 size-2 rounded-full shrink-0", dot)} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-tight">{n.title}</p>
        {n.body && <p className="text-xs text-muted-foreground mt-0.5">{n.body}</p>}
        <div className="flex items-center gap-2 mt-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
          </p>
          {n.link && (
            <span className="text-[10px] text-brand-orange font-medium">Open →</span>
          )}
        </div>
      </div>
    </button>
  );
}
