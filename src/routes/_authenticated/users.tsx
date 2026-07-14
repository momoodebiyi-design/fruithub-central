import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Plus, Copy } from "lucide-react";
import { ALL_ROLES, CAN_MANAGE_USERS, hasAny, ROLE_LABELS, type AppRole } from "@/lib/permissions";
import { useSession } from "@/hooks/useSession";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/users")({
  component: UsersPage,
});

interface Invite {
  id: string;
  email: string;
  role: AppRole;
  department: string | null;
  full_name: string | null;
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

interface UserRow {
  id: string;
  full_name: string | null;
  email: string;
  department: string | null;
  is_active: boolean;
  roles: AppRole[];
}

function UsersPage() {
  const session = useSession();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [open, setOpen] = useState(false);

  const canManage = hasAny(session.roles, CAN_MANAGE_USERS);

  useEffect(() => {
    if (session.loading) return;
    if (!canManage) return;
    void loadAll();
  }, [session.loading, canManage]);

  async function loadAll() {
    const [{ data: inv }, { data: profs }, { data: roleRows }] = await Promise.all([
      supabase.from("user_invites").select("*").is("accepted_at", null).order("created_at", { ascending: false }),
      supabase.from("profiles").select("id, full_name, email, department, is_active").order("full_name"),
      supabase.from("user_roles").select("user_id, role"),
    ]);
    setInvites((inv ?? []) as unknown as Invite[]);
    const roleMap = new Map<string, AppRole[]>();
    for (const r of (roleRows ?? []) as any[]) {
      const arr = roleMap.get(r.user_id) ?? [];
      arr.push(r.role);
      roleMap.set(r.user_id, arr);
    }
    setUsers(
      ((profs ?? []) as any[]).map((p) => ({
        id: p.id, full_name: p.full_name, email: p.email, department: p.department, is_active: p.is_active,
        roles: roleMap.get(p.id) ?? [],
      })),
    );
  }

  if (!session.loading && !canManage) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        You don't have permission to view users.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users & invites</h1>
          <p className="text-sm text-muted-foreground mt-1">Invite-only access · assign roles</p>
        </div>
        <NewInviteDialog open={open} setOpen={setOpen} onSaved={loadAll} />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Pending invites</h2>
        <div className="bg-card rounded-lg ring-1 ring-black/5 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Invite link</TableHead>
                <TableHead>Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.map((i) => {
                const url = `${window.location.origin}/auth?invite=${i.token}`;
                return (
                  <TableRow key={i.id}>
                    <TableCell className="font-medium">{i.email}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{ROLE_LABELS[i.role]}</Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(url);
                          toast.success("Invite link copied");
                        }}
                        className="font-mono text-[11px]"
                      >
                        <Copy className="size-3 mr-1" /> Copy link
                      </Button>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(i.expires_at), { addSuffix: true })}
                    </TableCell>
                  </TableRow>
                );
              })}
              {invites.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-6">No pending invites</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Active users</h2>
        <div className="bg-card rounded-lg ring-1 ring-black/5 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.full_name ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{u.email}</TableCell>
                  <TableCell className="text-xs">{u.department ?? "—"}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {u.roles.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
                      {u.roles.map((r) => (
                        <Badge key={r} variant="outline" className="text-[10px]">{ROLE_LABELS[r]}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {u.is_active ? (
                      <Badge className="bg-brand-green/15 text-brand-green border-0">Active</Badge>
                    ) : (
                      <Badge variant="outline">Inactive</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

function NewInviteDialog({ open, setOpen, onSaved }: { open: boolean; setOpen: (b: boolean) => void; onSaved: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AppRole>("production");
  const [fullName, setFullName] = useState("");
  const [department, setDepartment] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!email) return toast.error("Email is required");
    setSaving(true);
    const token = crypto.randomUUID().replace(/-/g, "");
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from("user_invites").insert({
      email: email.toLowerCase().trim(),
      role,
      full_name: fullName || null,
      department: department || null,
      token,
      invited_by: userData.user?.id,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    } as any);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Invite created — copy the link from the list");
    setEmail(""); setFullName(""); setDepartment("");
    setOpen(false);
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-brand-orange text-white hover:bg-brand-orange/90"><Plus className="size-4 mr-2" /> Invite user</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Invite a teammate</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Full name</Label><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
            <div><Label>Department</Label><Input value={department} onChange={(e) => setDepartment(e.target.value)} /></div>
          </div>
          <div>
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ALL_ROLES.map((r) => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-brand-orange text-white hover:bg-brand-orange/90">
            {saving ? "Creating…" : "Create invite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
