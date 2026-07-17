import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

// Local typed shim for the beta supabase.auth.oauth namespace.
type OAuthResult = {
  data: {
    client?: { name?: string; redirect_uris?: string[]; client_uri?: string } | null;
    scope?: string;
    redirect_url?: string;
    redirect_to?: string;
  } | null;
  error: { message: string } | null;
};
type OAuthApi = {
  getAuthorizationDetails: (id: string) => Promise<OAuthResult>;
  approveAuthorization: (id: string) => Promise<OAuthResult>;
  denyAuthorization: (id: string) => Promise<OAuthResult>;
};
function oauthApi(): OAuthApi {
  return (supabase.auth as unknown as { oauth: OAuthApi }).oauth;
}

export const Route = createFileRoute("/.lovable/oauth/consent")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("Missing authorization_id");
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      const next = location.pathname + location.searchStr;
      throw redirect({ to: "/auth", search: { next } as never });
    }
  },
  loader: async ({ location }) => {
    const authorizationId =
      new URLSearchParams(location.search).get("authorization_id") ?? "";
    const { data, error } = await oauthApi().getAuthorizationDetails(authorizationId);
    if (error) throw new Error(error.message);
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) {
      throw redirect({ href: immediate });
    }
    return data;
  },
  component: Consent,
  errorComponent: ({ error }) => (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md text-sm text-muted-foreground">
        Could not load this authorization request:{" "}
        {String((error as Error)?.message ?? error)}
      </div>
    </main>
  ),
});

function Consent() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const api = oauthApi();
    const { data, error } = approve
      ? await api.approveAuthorization(authorization_id)
      : await api.denyAuthorization(authorization_id);
    if (error) {
      setBusy(false);
      setError(error.message);
      return;
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      setBusy(false);
      setError("No redirect returned by the authorization server.");
      return;
    }
    window.location.href = target;
  }

  const clientName = details?.client?.name ?? "an external app";
  const scopeList = (details?.scope ?? "openid email profile")
    .split(/\s+/)
    .filter(Boolean);

  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md bg-card ring-1 ring-black/5 rounded-lg p-6 space-y-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Connect {clientName} to Juicery Ops
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {clientName} will be able to call Juicery Ops MCP tools while you're
            signed in. This does not bypass Juicery Ops permissions or
            row-level security — tools act as you.
          </p>
        </div>

        <div className="rounded-md bg-muted/40 p-3 space-y-2">
          <p className="text-xs font-medium text-foreground">Requested access</p>
          <ul className="text-xs text-muted-foreground space-y-1">
            {scopeList.map((s) => (
              <li key={s}>
                {s === "openid" && "Verify your identity"}
                {s === "email" && "Share your email address"}
                {s === "profile" && "Share your basic profile"}
                {!["openid", "email", "profile"].includes(s) && (
                  <>Additional permission: <code className="font-mono">{s}</code></>
                )}
              </li>
            ))}
          </ul>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2 justify-end">
          <Button variant="outline" disabled={busy} onClick={() => decide(false)}>
            Cancel connection
          </Button>
          <Button disabled={busy} onClick={() => decide(true)}>
            {busy ? "Working…" : "Approve"}
          </Button>
        </div>
      </div>
    </main>
  );
}
