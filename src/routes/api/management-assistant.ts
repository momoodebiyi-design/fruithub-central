/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/management-assistant")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!token) return Response.json({ error: "Sign in required" }, { status: 401 });
        const { authorisedUser, buildManagementBriefing } =
          await import("@/lib/management-briefing.server");
        const user = await authorisedUser(token, [
          "super_admin",
          "management",
          "operations_manager",
        ]);
        if (!user) return Response.json({ error: "Management access required" }, { status: 403 });
        let body: { question?: unknown };
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid request" }, { status: 400 });
        }
        const question = typeof body.question === "string" ? body.question.trim() : "";
        if (question.length < 3 || question.length > 500) {
          return Response.json(
            { error: "Ask a question between 3 and 500 characters" },
            { status: 400 },
          );
        }
        const apiKey = process.env.OPENAI_API_KEY?.trim();
        const model = process.env.OPENAI_MODEL?.trim();
        if (!apiKey || !model)
          return Response.json(
            { error: "The AI assistant is not configured yet" },
            { status: 503 },
          );

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as any;
        const startOfDay = new Date(
          `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
        ).toISOString();
        const { count } = await admin
          .from("audit_log")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("action", "management_assistant.asked")
          .gte("created_at", startOfDay);
        if ((count ?? 0) >= 20)
          return Response.json(
            { error: "Daily assistant question limit reached" },
            { status: 429 },
          );

        const briefing = await buildManagementBriefing();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);
        try {
          const response = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              model,
              store: false,
              max_output_tokens: 350,
              instructions:
                "You are a read-only low-stock briefing assistant for 4ruit Naturel. Answer only from the provided database-derived item/location stock counts and approved reorder levels. Never invent counts, thresholds, causes, sales, or stock figures. Clearly distinguish an unconfigured reorder policy from zero stock, and unavailable data from zero. If the question needs facts outside this briefing, say that the app's inventory reports must be checked. Do not propose or perform stock changes, approvals, or messages. Keep answers concise and practical.",
              input: `Briefing JSON: ${JSON.stringify(briefing)}\nManagement question: ${question}`,
            }),
          });
          const result = (await response.json().catch(() => ({}))) as any;
          if (!response.ok)
            return Response.json(
              { error: "The assistant could not answer right now" },
              { status: 503 },
            );
          const answer = Array.isArray(result.output)
            ? result.output
                .flatMap((part: any) =>
                  part.type === "message" && Array.isArray(part.content)
                    ? part.content
                        .filter((content: any) => content.type === "output_text")
                        .map((content: any) => content.text)
                    : [],
                )
                .join("\n")
                .trim()
            : "";
          if (!answer)
            return Response.json({ error: "The assistant returned no answer" }, { status: 503 });
          await admin.from("audit_log").insert({
            user_id: user.id,
            action: "management_assistant.asked",
            entity: "management_briefing",
            entity_id: briefing.reportDate,
            new_value: { report_date: briefing.reportDate, model },
          });
          return Response.json({ answer, reportDate: briefing.reportDate });
        } catch {
          return Response.json({ error: "The assistant timed out; try again" }, { status: 503 });
        } finally {
          clearTimeout(timeout);
        }
      },
    },
  },
});
