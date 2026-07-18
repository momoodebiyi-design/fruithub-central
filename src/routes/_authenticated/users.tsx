import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Plus, Copy, UserCheck, UserX, XCircle } from "lucide-react";
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
  shop_id: string | null;
  roles: AppRole[];
}

interface ShopOpt {
  id: string;
  name: string;
}

type ReasonAction =
  | { kind: "cancel_invite"; invite: Invite }
  | { kind: "set_status"; user: UserRow; isActive: boolean };

function UsersPage() {
  const session = useSession();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [shops, setShops] = useState<ShopOpt[]>([]);
  const [open, setOpen] = useState(false);
  const [reasonAction, setReasonAction] = useState<ReasonAction | null>(null);
  const [reason, setReason] = useState("");
  const [savingAction, setSavingAction] = useState(false);

  const canManage = hasAny(session.roles, CAN_MANAGE_USERS);
  const actorIsSuperAdmin = session.roles.includes("super_admin");
  const activeSuperAdminCount = users.filter(
    (user) => user.is_active && user.roles.includes("super_admin"),
  ).length;

  useEffect(() => {
    if (session.loading) return;
    if (!canManage) return;
    void loadAll();
  }, [session.loading, canManage]);

  async function loadAll() {
    const [inviteResult, profileResult, roleResult, shopResult] = await Promise.all([
      supabase
        .from("user_invites")
        .select("*")
        .is("accepted_at", null)
        .is("cancelled_at", null)
        .order("created_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("id, full_name, email, department, is_active, shop_id")
        .order("full_name"),
      supabase.from("user_roles").select("user_id, role"),
      supabase.from("shops").select("id, name").eq("is_active", true).order("name"),
    ]);

    const firstError = [
      inviteResult.error,
      profileResult.error,
      roleResult.error,
      shopResult.error,
    ].find(Boolean);
    if (firstError) {
      toast.error(`Unable to load users: ${firstError.message}`);
      return;
    }

    setInvites((inviteResult.data ?? []) as unknown as Invite[]);
    setShops((shopResult.data as ShopOpt[]) ?? []);
    const roleMap = new Map<string, AppRole[]>();
    for (const r of roleResult.data ?? []) {
      const arr = roleMap.get(r.user_id) ?? [];
      arr.push(r.role as AppRole);
      roleMap.set(r.user_id, arr);
    }
    setUsers(
      (profileResult.data ?? []).map((p) => ({
        id: p.id,
        full_name: p.full_name,
        email: p.email,
        department: p.department,
        is_active: p.is_active,
        shop_id: p.shop_id ?? null,
        roles: roleMap.get(p.id) ?? [],
      })),
    );
  }

  async function assignShop(userId: string, shopId: string | null) {
    const { error } = await supabase.from("profiles").update({ shop_id: shopId }).eq("id", userId);
    if (error) return toast.error(error.message);
    toast.success("Shop assignment updated");
    setUsers((us) => us.map((u) => (u.id === userId ? { ...u, shop_id: shopId } : u)));
  }

  function openReasonAction(action: ReasonAction) {
    setReason("");
    setReasonAction(action);
  }

  async function submitReasonAction() {
    if (!reasonAction) return;
    const cleanReason = reason.trim();
    if (!cleanReason) return toast.error("A reason is required");

    setSavingAction(true);
    const result =
      reasonAction.kind === "cancel_invite"
        ? await supabase.rpc("cancel_user_invite", {
            _invite_id: reasonAction.invite.id,
            _reason: cleanReason,
          })
        : await supabase.rpc("set_user_active_status", {
            _target_user_id: reasonAction.user.id,
            _is_active: reasonAction.isActive,
            _reason: cleanReason,
          });
    setSavingAction(false);

    if (result.error) return toast.error(result.error.message);

    const successMessage =
      reasonAction.kind === "cancel_invite"
        ? "Invitation cancelled"
        : reasonAction.isActive
          ? "User reactivated"
          : "User deactivated";
    toast.success(successMessage);
    setReasonAction(null);
    setReason("");
    await loadAll();
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
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Pending invites
        </h2>
        <div className="bg-card rounded-lg ring-1 ring-black/5 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Invite link</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
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
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openReasonAction({ kind: "cancel_invite", invite: i })}
                        className="text-destructive hover:text-destructive"
                      >
                        <XCircle className="size-3.5 mr-1" /> Cancel
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {invites.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">
                    No pending invites
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Users
        </h2>
        <div className="bg-card rounded-lg ring-1 ring-black/5 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Shop</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => {
                const isSupervisor = u.roles.includes("shop_supervisor");
                const isSuperAdmin = u.roles.includes("super_admin");
                const isCurrentUser = u.id === session.user?.id;
                const isProtectedFromActor = isSuperAdmin && !actorIsSuperAdmin;
                const isLastActiveSuperAdmin =
                  isSuperAdmin && u.is_active && activeSuperAdminCount <= 1;
                const statusActionDisabled =
                  isCurrentUser || isProtectedFromActor || isLastActiveSuperAdmin;
                return (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.full_name ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{u.email}</TableCell>
                    <TableCell className="text-xs">{u.department ?? "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {u.roles.length === 0 && (
                          <span className="text-xs text-muted-foreground">none</span>
                        )}
                        {u.roles.map((r) => (
                          <Badge key={r} variant="outline" className="text-[10px]">
                            {ROLE_LABELS[r]}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      {isSupervisor ? (
                        <Select
                          value={u.shop_id ?? "__none"}
                          onValueChange={(v) => assignShop(u.id, v === "__none" ? null : v)}
                          disabled={!u.is_active}
                        >
                          <SelectTrigger className="w-40 h-8 text-xs">
                            <SelectValue placeholder="Assign shop" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none">— none —</SelectItem>
                            {shops.map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {s.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {u.is_active ? (
                        <Badge className="bg-brand-green/15 text-brand-green border-0">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline">Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {statusActionDisabled ? (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {isCurrentUser
                            ? "Current user"
                            : isProtectedFromActor
                              ? "Super Admin protected"
                              : "Last Super Admin"}
                        </span>
                      ) : (
                        <Button
                          variant={u.is_active ? "outline" : "default"}
                          size="sm"
                          onClick={() =>
                            openReasonAction({
                              kind: "set_status",
                              user: u,
                              isActive: !u.is_active,
                            })
                          }
                        >
                          {u.is_active ? (
                            <>
                              <UserX className="size-3.5 mr-1" /> Deactivate
                            </>
                          ) : (
                            <>
                              <UserCheck className="size-3.5 mr-1" /> Reactivate
                            </>
                          )}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      <ReasonActionDialog
        action={reasonAction}
        reason={reason}
        saving={savingAction}
        onReasonChange={setReason}
        onClose={() => {
          if (savingAction) return;
          setReasonAction(null);
          setReason("");
        }}
        onConfirm={submitReasonAction}
      />
    </div>
  );
}

function ReasonActionDialog({
  action,
  reason,
  saving,
  onReasonChange,
  onClose,
  onConfirm,
}: {
  action: ReasonAction | null;
  reason: string;
  saving: boolean;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isCancellation = action?.kind === "cancel_invite";
  const isReactivation = action?.kind === "set_status" && action.isActive;
  const title = isCancellation
    ? "Cancel invitation?"
    : isReactivation
      ? "Reactivate user?"
      : "Deactivate user?";
  const subject =
    action?.kind === "cancel_invite"
      ? action.invite.email
      : action?.kind === "set_status"
        ? (action.user.full_name ?? action.user.email)
        : "this record";

  return (
    <Dialog open={action !== null} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isCancellation
              ? `The pending link for ${subject} will stop working. The invitation history will be retained.`
              : isReactivation
                ? `${subject} will regain application access with their existing roles.`
                : `${subject} will lose application access. Their roles and history will be retained.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="lifecycle-reason">Reason</Label>
          <Input
            id="lifecycle-reason"
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            placeholder="Required for the audit log"
            disabled={saving}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Keep unchanged
          </Button>
          <Button
            variant={isReactivation ? "default" : "destructive"}
            onClick={onConfirm}
            disabled={saving || reason.trim().length === 0}
          >
            {saving
              ? "Saving…"
              : isCancellation
                ? "Cancel invite"
                : isReactivation
                  ? "Reactivate user"
                  : "Deactivate user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewInviteDialog({
  open,
  setOpen,
  onSaved,
}: {
  open: boolean;
  setOpen: (b: boolean) => void;
  onSaved: () => void;
}) {
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
    setEmail("");
    setFullName("");
    setDepartment("");
    setOpen(false);
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-brand-orange text-white hover:bg-brand-orange/90">
          <Plus className="size-4 mr-2" /> Invite user
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Full name</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div>
              <Label>Department</Label>
              <Input value={department} onChange={(e) => setDepartment(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving}
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            {saving ? "Creating…" : "Create invite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
