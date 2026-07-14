import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    invite: typeof s.invite === "string" ? s.invite : undefined,
    mode: s.mode === "signup" ? "signup" : "signin",
  }),
  component: AuthPage,
});

function AuthPage() {
  const { invite, mode } = Route.useSearch();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"signin" | "signup">(invite ? "signup" : mode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [firstUserMode, setFirstUserMode] = useState(false);

  // Check if any users exist — if none, allow first-user signup even without invite
  useEffect(() => {
    (async () => {
      const { count } = await supabase.from("user_roles").select("*", { count: "exact", head: true });
      setFirstUserMode((count ?? 0) === 0);
    })();
  }, []);

  // Prefill invite email
  useEffect(() => {
    if (!invite) return;
    (async () => {
      const { data } = await supabase
        .from("user_invites")
        .select("email")
        .eq("token", invite)
        .is("accepted_at", null)
        .maybeSingle();
      if (data?.email) setEmail(data.email);
    })();
  }, [invite]);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return toast.error(error.message);
    navigate({ to: "/dashboard" });
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/dashboard`,
        data: { full_name: fullName },
      },
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Account created — you're signed in.");
    navigate({ to: "/dashboard" });
  }

  async function handleReset() {
    if (!email) return toast.error("Enter your email first");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) toast.error(error.message);
    else toast.success("If that email exists, a reset link was sent.");
  }

  const canSignup = !!invite || firstUserMode;

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
          {tab === "signin" ? (
            <form onSubmit={handleSignIn} className="space-y-4">
              <div>
                <h1 className="text-xl font-semibold">Sign in</h1>
                <p className="text-xs text-muted-foreground mt-1">
                  Internal operations platform. Invite-only access.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Signing in…" : "Sign in"}
              </Button>
              <div className="flex items-center justify-between text-xs">
                <button type="button" onClick={handleReset} className="text-muted-foreground hover:text-foreground">
                  Forgot password?
                </button>
                {canSignup && (
                  <button type="button" onClick={() => setTab("signup")} className="text-brand-orange font-medium">
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
                <Input id="full_name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email2">Email</Label>
                <Input id="email2" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password2">Password</Label>
                <Input id="password2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Creating…" : firstUserMode ? "Create account" : "Accept invite"}
              </Button>
              <div className="text-center">
                <button type="button" onClick={() => setTab("signin")} className="text-xs text-muted-foreground">
                  Already have an account? Sign in
                </button>
              </div>
            </form>
          )}
        </div>
        <p className="text-center text-[11px] text-muted-foreground mt-6">
          <Link to="/reset-password" className="hover:text-foreground">Reset password</Link>
        </p>
      </div>
    </div>
  );
}
