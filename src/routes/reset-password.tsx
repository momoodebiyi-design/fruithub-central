import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    mode: search.mode === "invite" ? ("invite" as const) : undefined,
  }),
  component: ResetPage,
});

function ResetPage() {
  const { mode } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionState, setSessionState] = useState<"checking" | "ready" | "invalid">("checking");
  const navigate = useNavigate();

  useEffect(() => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (!settled) setSessionState("invalid");
    }, 8000);

    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        settled = true;
        window.clearTimeout(timeout);
        setSessionState("ready");
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) return;
      settled = true;
      window.clearTimeout(timeout);
      setSessionState("ready");
    });

    return () => {
      settled = true;
      window.clearTimeout(timeout);
      listener.subscription.unsubscribe();
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Password updated");
    navigate({ to: "/dashboard" });
  }

  if (sessionState === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm bg-card ring-1 ring-black/5 rounded-lg p-6 text-center">
          <h1 className="text-xl font-semibold">Preparing your secure link…</h1>
          <p className="mt-2 text-sm text-muted-foreground">This should only take a moment.</p>
        </div>
      </div>
    );
  }

  if (sessionState === "invalid") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm bg-card ring-1 ring-black/5 rounded-lg p-6 text-center space-y-4">
          <div>
            <h1 className="text-xl font-semibold">Link unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This link is invalid or has expired. Ask an administrator to resend the invitation, or
              request another password reset.
            </p>
          </div>
          <Button asChild className="w-full">
            <Link to="/auth">Return to sign in</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-card ring-1 ring-black/5 rounded-lg p-6 space-y-4"
      >
        <div>
          <h1 className="text-xl font-semibold">
            {mode === "invite" ? "Activate your account" : "Set a new password"}
          </h1>
          {mode === "invite" && (
            <p className="mt-1 text-sm text-muted-foreground">
              Choose a password to finish accepting your invitation.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p">New password</Label>
          <Input
            id="p"
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Saving…" : "Update password"}
        </Button>
      </form>
    </div>
  );
}
