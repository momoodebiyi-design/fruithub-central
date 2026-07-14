import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";
import { useSession } from "@/hooks/useSession";
import { CAN_VIEW_AUDIT, hasAny } from "@/lib/permissions";

export const Route = createFileRoute("/_authenticated/audit")({
  component: AuditPage,
});

interface AuditRow {
  id: string;
  user_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  new_value: any;
  previous_value: any;
  created_at: string;
  actor_name?: string | null;
}

function AuditPage() {
  const session = useSession();
  const canView = hasAny(session.roles, CAN_VIEW_AUDIT);
  const [rows, setRows] = useState<AuditRow[]>([]);

  useEffect(() => {
    if (!canView) return;
    (async () => {
      const { data } = await supabase
        .from("audit_log")
        .select("id, user_id, action, entity, entity_id, new_value, previous_value, created_at")
        .order("created_at", { ascending: false })
        .limit(200);
      const list = (data ?? []) as AuditRow[];
      const ids = Array.from(new Set(list.map((r) => r.user_id).filter(Boolean))) as string[];
      if (ids.length) {
        const { data: profs } = await supabase.from("profiles").select("id, full_name, email").in("id", ids);
        const map = new Map<string, string>();
        for (const p of (profs ?? []) as any[]) map.set(p.id, p.full_name ?? p.email);
        for (const r of list) r.actor_name = r.user_id ? (map.get(r.user_id) ?? null) : null;
      }
      setRows(list);
    })();
  }, [canView]);

  if (session.loading) return null;
  if (!canView) {
    return <div className="p-8 text-sm text-muted-foreground">You don't have permission to view audit logs.</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted-foreground mt-1">All privileged actions across the platform.</p>
      </div>
      <div className="bg-card rounded-lg ring-1 ring-black/5 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                </TableCell>
                <TableCell className="text-xs">{r.actor_name ?? "system"}</TableCell>
                <TableCell><Badge variant="outline" className="text-[10px] uppercase tracking-wider">{r.action}</Badge></TableCell>
                <TableCell className="text-xs font-mono">{r.entity}</TableCell>
                <TableCell className="text-[11px] font-mono text-muted-foreground max-w-md truncate">
                  {r.new_value ? JSON.stringify(r.new_value) : r.previous_value ? JSON.stringify(r.previous_value) : "—"}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">No audit entries</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
