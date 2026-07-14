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
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  metadata: any;
  created_at: string;
  actor: { full_name: string | null; email: string } | null;
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
        .select("id, actor_id, action, entity, entity_id, metadata, created_at, actor:profiles!audit_log_actor_id_fkey(full_name, email)")
        .order("created_at", { ascending: false })
        .limit(200);
      setRows((data ?? []) as unknown as AuditRow[]);
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
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                </TableCell>
                <TableCell className="text-xs">{r.actor?.full_name ?? r.actor?.email ?? "system"}</TableCell>
                <TableCell><Badge variant="outline" className="text-[10px] uppercase tracking-wider">{r.action}</Badge></TableCell>
                <TableCell className="text-xs font-mono">{r.entity}</TableCell>
                <TableCell className="text-[11px] font-mono text-muted-foreground max-w-xs truncate">
                  {r.metadata ? JSON.stringify(r.metadata) : "—"}
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
