import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>): AuthSearch => ({
    invite: typeof s.invite === "string" ? s.invite : undefined,
    mode: s.mode === "signup" ? "signup" : undefined,
    next: typeof s.next === "string" ? s.next : undefined,
    reason: s.reason === "inactive" ? "inactive" : undefined,
  }),
  pendingComponent: AuthPage,
  component: AuthPage,
});

interface AuthSearch {
  invite?: string;
  mode?: "signup";
  next?: string;
  reason?: "inactive";
}

/** Only accept a same-origin relative path so we can't be used as an open redirect. */
function safeNext(next: string | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

export function AuthPage() {
  const { invite, mode, next, reason } = Route.useSearch();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [firstUserMode, setFirstUserMode] = useState(false);
  const [inviteValid, setInviteValid] = useState<boolean | null>(invite ? null : false);
  const [awaitingEmail, setAwaitingEmail] = useState(false);

  // Bootstrap allowance is authoritative via SECURITY DEFINER RPC — an
  // anonymous count of user_roles would be blocked by RLS and give a false
  // "first user" state. Never show the super-admin path once initialized.
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("bootstrap_allowed");
      if (!error) {
        const allowed = Boolean(data);
        setFirstUserMode(allowed);
        if (allowed && !invite && mode === "signup") setTab("signup");
      }
    })();
  }, [invite, mode]);

  // Validate the invite before exposing signup, then lock signup to its email.
  useEffect(() => {
    let cancelled = false;

    if (!invite) {
      setInviteValid(false);
      return;
    }

    (async () => {
      const { data, error } = await supabase.rpc("validate_user_invite", { _token: invite });
      const validInvite = data?.[0];

      if (cancelled) return;

      if (error || !validInvite?.email) {
        setInviteValid(false);
        setTab("signin");
        toast.error("This invite is invalid or has expired.");
        return;
      }

      setEmail(validInvite.email);
      setFullName(validInvite.full_name ?? "");
      setInviteValid(true);
      setTab("signup");
    })();

    return () => {
      cancelled = true;
    };
  }, [invite]);

  function goPostAuth() {
    const dest = safeNext(next);
    if (dest) {
      window.location.href = dest;
      return;
    }
    navigate({ to: "/dashboard" });
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return toast.error(error.message);
    goPostAuth();
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();

    if (!firstUserMode && inviteValid !== true) {
      setTab("signin");
      return toast.error("A valid invitation is required to create an account.");
    }

    setLoading(true);
    const dest = safeNext(next);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}${dest ?? "/dashboard"}`,
        data: {
          full_name: fullName,
          ...(inviteValid === true && invite ? { invite_token: invite } : {}),
        },
      },
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    if (data.session) {
      toast.success("Account created");
      goPostAuth();
      return;
    }
    setAwaitingEmail(true);
    toast.success("Check your email to confirm your account");
  }

  async function resendConfirmation() {
    if (!email) return;
    setLoading(true);
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth?mode=signin` },
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Confirmation email resent");
  }

  async function handleReset() {
    if (!email) return toast.error("Enter your email first");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) toast.error(error.message);
    else toast.success("If that email exists, a reset link was sent.");
  }

  const canSignup = inviteValid === true || firstUserMode;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 justify-center mb-8">
          <div className="size-8 rounded-md bg-brand-orange ring-1 ring-black/10 flex items-center justify-center">
            <div className="size-2.5 bg-white rounded-full opacity-80" />
          </div>
          <span className="text-lg font-semibold tracking-tight">Juicery Ops</span>
        </div>

        <div className="bg-card ring-1 ring-black/5 rounded-lg p-6">
          {reason === "inactive" && (
            <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <p className="font-medium text-destructive">Account inactive</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Your access has been deactivated. Contact an administrator if you believe this is a
                mistake.
              </p>
            </div>
          )}
          {awaitingEmail ? (
            <div className="space-y-4">
              <div>
                <h1 className="text-xl font-semibold">Check your email</h1>
                <p className="text-sm text-muted-foreground mt-2">
                  We sent a confirmation link to{" "}
                  <span className="font-medium text-foreground">{email}</span>. Open it to finish
                  activating your account.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={resendConfirmation}
                disabled={loading}
              >
                {loading ? "Sending…" : "Resend confirmation email"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setAwaitingEmail(false);
                  setTab("signin");
                }}
              >
                Back to sign in
              </Button>
            </div>
          ) : tab === "signin" ? (
            <form onSubmit={handleSignIn} className="space-y-4">
              <div>
                <h1 className="text-xl font-semibold">Sign in</h1>
                <p className="text-xs text-muted-foreground mt-1">
                  Internal operations platform. Invite-only access.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Signing in…" : "Sign in"}
              </Button>
              <div className="flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={handleReset}
                  className="text-muted-foreground hover:text-foreground"
                >
                  Forgot password?
                </button>
                {canSignup && (
                  <button
                    type="button"
                    onClick={() => setTab("signup")}
                    className="text-brand-orange font-medium"
                  >
                    {firstUserMode ? "Create super admin →" : "Accept invite →"}
                  </button>
                )}
              </div>
            </form>
          ) : (
            <form onSubmit={handleSignUp} className="space-y-4">
              <div>
                <h1 className="text-xl font-semibold">
                  {firstUserMode ? "Create super admin" : "Accept your invite"}
                </h1>
                <p className="text-xs text-muted-foreground mt-1">
                  {firstUserMode
                    ? "You're the first user — you'll get super-admin access."
                    : "Set your password to activate your account."}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="full_name">Full name</Label>
                <Input
                  id="full_name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email2">Email</Label>
                <Input
                  id="email2"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  readOnly={inviteValid === true}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password2">Password</Label>
                <Input
                  id="password2"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={loading || (!firstUserMode && inviteValid !== true)}
              >
                {loading ? "Creating…" : firstUserMode ? "Create account" : "Accept invite"}
              </Button>
              <div className="text-center">
                <button
                  type="button"
                  onClick={() => setTab("signin")}
                  className="text-xs text-muted-foreground"
                >
                  Already have an account? Sign in
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
