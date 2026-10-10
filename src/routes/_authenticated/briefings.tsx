import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ManagementBriefing } from "@/lib/management-briefing.server";

export const Route = createFileRoute("/_authenticated/briefings")({ component: BriefingsPage });

async function api(path: string, body?: unknown) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to continue");
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed");
  return result;
}

function metric(value: number | null) {
  return value === null ? "Unavailable" : value.toLocaleString("en-NG");
}

function BriefingsPage() {
  const session = useSession();
  const isManagement = session.roles.some((role) =>
    ["super_admin", "management", "operations_manager"].includes(role),
  );
  const isSuperAdmin = session.roles.includes("super_admin");
  const [briefing, setBriefing] = useState<ManagementBriefing | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [hasPhone, setHasPhone] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!isManagement) return;
    try {
      const result = await api("/api/management-briefing");
      setBriefing(result.briefing);
      setEnabled(result.pilot.enabled);
      setHasPhone(result.pilot.hasPhone);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load briefing");
    }
  }, [isManagement]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(action: "enrol" | "disable" | "send") {
    setLoading(true);
    setMessage("");
    try {
      await api("/api/management-briefing", { action });
      setMessage(
        action === "enrol"
          ? "Pilot enabled for your saved Super Admin number."
          : action === "disable"
            ? "WhatsApp pilot disabled."
            : "Briefing sent to your saved number.",
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed");
    } finally {
      setLoading(false);
    }
  }

  async function ask() {
    if (!question.trim()) return;
    setLoading(true);
    setMessage("");
    setAnswer("");
    try {
      const result = await api("/api/management-assistant", { question });
      setAnswer(result.answer);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Assistant unavailable");
    } finally {
      setLoading(false);
    }
  }

  if (!session.loading && !isManagement)
    return <p className="text-sm text-muted-foreground">Management access required.</p>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Management briefing</h1>
        <p className="text-sm text-muted-foreground">
          Previous-day operations, with live stock and approval alerts. All times are Lagos time.
        </p>
      </div>
      {message && (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {message}
        </p>
      )}
      {briefing && (
        <>
          <div className="rounded-lg bg-card ring-1 ring-black/5 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">{briefing.reportDate}</h2>
              <span className="text-xs text-muted-foreground">
                As of{" "}
                {new Date(briefing.asOf).toLocaleString("en-NG", { timeZone: "Africa/Lagos" })}
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div>
                Production batches
                <br />
                <strong>{metric(briefing.productionBatches)}</strong>
              </div>
              <div>
                Dispatches
                <br />
                <strong>{metric(briefing.dispatches)}</strong>
              </div>
              <div>
                Returns
                <br />
                <strong>{metric(briefing.returns)}</strong>
              </div>
              <div>
                Central stocktakes posted
                <br />
                <strong>{metric(briefing.stocktakesPosted)}</strong>
              </div>
              <div>
                Uncounted stocktake lines
                <br />
                <strong>{metric(briefing.uncountedStocktakeLines)}</strong>
              </div>
              <div>
                Low-stock items now
                <br />
                <strong>
                  {briefing.lowStock === null ? "Unavailable" : briefing.lowStock.length}
                </strong>
              </div>
              <div>
                Purchase approvals now
                <br />
                <strong>{metric(briefing.pendingPurchaseApprovals)}</strong>
              </div>
            </div>
            {briefing.warnings.map((warning) => (
              <p key={warning} className="text-sm text-amber-700">
                ⚠ {warning}
              </p>
            ))}
            {briefing.lowStock && briefing.lowStock.length > 0 && (
              <div className="text-sm">
                <h3 className="font-medium mb-1">Low Central stock</h3>
                <ul className="list-disc pl-5 space-y-1">
                  {briefing.lowStock.slice(0, 10).map((item) => (
                    <li key={item.name}>
                      {item.name}: {item.onHand} on hand (reorder at {item.reorderLevel})
                      {item.critical ? " — critical" : ""}
                    </li>
                  ))}
                </ul>
                {briefing.lowStock.length > 10 && (
                  <p className="text-muted-foreground mt-1">
                    Open Central Stock for the full list.
                  </p>
                )}
              </div>
            )}
          </div>
          {isSuperAdmin && (
            <div className="rounded-lg bg-card ring-1 ring-black/5 p-5 space-y-3">
              <h2 className="font-semibold">WhatsApp pilot</h2>
              <p className="text-sm text-muted-foreground">
                Only your saved Super Admin phone receives the 8:00 a.m. briefing. Text “briefing”
                from that number to request the latest completed day, or “STOP” to disable delivery.
                No other management accounts are enrolled.
              </p>
              {!hasPhone && (
                <p className="text-sm text-amber-700">
                  Add your WhatsApp number to your Super Admin profile first.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={loading || !hasPhone}
                  onClick={() => void act(enabled ? "disable" : "enrol")}
                >
                  {enabled ? "Disable pilot" : "I consent — enable pilot"}
                </Button>
                <Button
                  variant="outline"
                  disabled={loading || !enabled}
                  onClick={() => void act("send")}
                >
                  Send briefing now
                </Button>
              </div>
            </div>
          )}
          <div className="rounded-lg bg-card ring-1 ring-black/5 p-5 space-y-3">
            <h2 className="font-semibold">Ask about this briefing</h2>
            <p className="text-sm text-muted-foreground">
              Read-only answers from the figures above. The assistant cannot change stock or approve
              requests. When configured, your question and this briefing are sent to the AI provider
              to generate an answer.
            </p>
            <div className="flex gap-2">
              <Input
                value={question}
                maxLength={500}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void ask();
                }}
                placeholder="What needs my attention?"
              />
              <Button disabled={loading || !question.trim()} onClick={() => void ask()}>
                Ask
              </Button>
            </div>
            {answer && (
              <p className="whitespace-pre-wrap text-sm rounded-md bg-muted p-3">{answer}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
