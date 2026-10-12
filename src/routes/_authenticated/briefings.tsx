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

function BriefingsPage() {
  const session = useSession();
  const isManagement = session.roles.some((role) =>
    ["super_admin", "management", "operations_manager"].includes(role),
  );
  const [briefing, setBriefing] = useState<ManagementBriefing | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [hasPhone, setHasPhone] = useState(false);
  const [readiness, setReadiness] = useState<{
    activeManagement: number;
    withPhone: number;
    optedIn: number;
  } | null>(null);
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
      setReadiness(result.readiness);
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
          ? "Daily low-stock WhatsApp briefing enabled for your saved number."
          : action === "disable"
            ? "WhatsApp briefings disabled for your account."
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
          Low-stock counts across the tracked inventory, using current location balances and
          approved reorder levels. Times are Lagos time.
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                Low-stock counts
                <br />
                <strong>
                  {briefing.lowStock === null
                    ? "Unavailable"
                    : briefing.lowStock.length.toLocaleString("en-NG")}
                </strong>
              </div>
              <div>
                Critical counts
                <br />
                <strong>
                  {briefing.lowStock === null
                    ? "Unavailable"
                    : briefing.lowStock
                        .filter((line) => line.critical)
                        .length.toLocaleString("en-NG")}
                </strong>
              </div>
              <div>
                Reorder levels configured
                <br />
                <strong>
                  {briefing.configuredPairs?.toLocaleString("en-NG") ?? "Unavailable"}
                </strong>
              </div>
              <div>
                Reorder levels missing
                <br />
                <strong>
                  {briefing.unconfiguredPairs?.toLocaleString("en-NG") ?? "Unavailable"}
                </strong>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Locations: {briefing.locationNames.join(", ") || "Unavailable"}. Items without a
              configured reorder level are not guessed as low stock.
            </p>
            {briefing.warnings.map((warning) => (
              <p key={warning} className="text-sm text-amber-700">
                ⚠ {warning}
              </p>
            ))}
            {briefing.lowStock && briefing.lowStock.length > 0 && (
              <div className="text-sm">
                <h3 className="font-medium mb-1">All low-stock counts</h3>
                <ul className="space-y-1 max-h-96 overflow-y-auto">
                  {briefing.lowStock.map((item) => (
                    <li key={`${item.locationId}:${item.itemId}`} className="border-b py-1">
                      <span className="font-medium">{item.name}</span> ·{" "}
                      {item.category.replaceAll("_", " ")} · {item.locationName}: {item.onHand}{" "}
                      {item.unit} on hand (reorder at {item.reorderLevel})
                      {item.critical ? " — critical" : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {isManagement && (
            <div className="rounded-lg bg-card ring-1 ring-black/5 p-5 space-y-3">
              <h2 className="font-semibold">Daily WhatsApp low-stock briefing</h2>
              <p className="text-sm text-muted-foreground">
                Active management users can individually opt in to an 8:00 a.m. Lagos briefing on
                their saved WhatsApp number. Text “briefing” from that number for the current
                low-stock snapshot, or “STOP” to opt out. You will only receive messages after you
                consent.
              </p>
              {readiness && (
                <p className="text-sm rounded-md bg-muted p-3">
                  Recipient readiness: {readiness.optedIn} of {readiness.activeManagement} active
                  management users opted in; {readiness.withPhone} have a valid saved WhatsApp
                  number.
                </p>
              )}
              {!hasPhone && (
                <p className="text-sm text-amber-700">
                  Add your WhatsApp number in Profile settings first.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={loading || !hasPhone}
                  onClick={() => void act(enabled ? "disable" : "enrol")}
                >
                  {enabled ? "Stop WhatsApp briefings" : "I consent — enable WhatsApp briefings"}
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
