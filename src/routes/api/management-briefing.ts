/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export const Route = createFileRoute("/api/management-briefing")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Sign in required" }, 401);
        const [{ authorisedUser, buildManagementBriefing }, { supabaseAdmin }] = await Promise.all([
          import("@/lib/management-briefing.server"),
          import("@/integrations/supabase/client.server"),
        ]);
        const user = await authorisedUser(token, [
          "super_admin",
          "management",
          "operations_manager",
        ]);
        if (!user) return json({ error: "Management access required" }, 403);
        const briefing = await buildManagementBriefing();
        const { data: pilot } = await (supabaseAdmin as any)
          .from("management_briefing_pilot")
          .select("enabled,consented_at")
          .eq("user_id", user.id)
          .maybeSingle();
        return json({
          briefing,
          pilot: { enabled: pilot?.enabled === true, hasPhone: Boolean(user.phone) },
        });
      },
      POST: async ({ request }) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Sign in required" }, 401);
        const {
          authorisedUser,
          normalisePhone,
          buildManagementBriefing,
          createBriefingDelivery,
          sendWhatsAppBriefing,
        } = await import("@/lib/management-briefing.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as any;
        const user = await authorisedUser(token, ["super_admin"]);
        if (!user) return json({ error: "Super Admin access required" }, 403);

        let body: { action?: string };
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid request" }, 400);
        }
        if (body.action === "enrol") {
          if (!normalisePhone(user.phone ?? ""))
            return json(
              { error: "Add a valid WhatsApp number to your Super Admin profile first" },
              400,
            );
          const { error } = await admin.from("management_briefing_pilot").upsert(
            {
              user_id: user.id,
              enabled: true,
              consented_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" },
          );
          if (error)
            return json(
              {
                error:
                  error.code === "23505"
                    ? "Another Super Admin is already enrolled in the one-person pilot"
                    : error.message,
              },
              409,
            );
          await admin.from("audit_log").insert({
            user_id: user.id,
            action: "management_briefing.pilot_enrolled",
            entity: "management_briefing_pilot",
            entity_id: user.id,
            new_value: { schedule: "08:00 Africa/Lagos" },
          });
          return json({ enabled: true });
        }
        if (body.action === "disable") {
          const { error } = await admin
            .from("management_briefing_pilot")
            .update({ enabled: false, updated_at: new Date().toISOString() })
            .eq("user_id", user.id);
          if (error) return json({ error: error.message }, 500);
          await admin.from("audit_log").insert({
            user_id: user.id,
            action: "management_briefing.pilot_disabled",
            entity: "management_briefing_pilot",
            entity_id: user.id,
          });
          return json({ enabled: false });
        }
        if (body.action === "send") {
          const { data: pilot } = await admin
            .from("management_briefing_pilot")
            .select("enabled")
            .eq("user_id", user.id)
            .maybeSingle();
          if (!pilot?.enabled) return json({ error: "Enable the WhatsApp pilot first" }, 403);
          const briefing = await buildManagementBriefing();
          const id = await createBriefingDelivery(user.id, briefing.reportDate, "in_app_request");
          if (!id) return json({ error: "Briefing request limit reached; try again later" }, 429);
          try {
            const sent = await sendWhatsAppBriefing(
              id,
              user.id,
              briefing,
              "in_app_request",
              new URL(request.url).origin,
            );
            if (!sent) return json({ error: "Briefing is already being sent" }, 409);
          } catch (error) {
            return json(
              { error: error instanceof Error ? error.message : "WhatsApp send failed" },
              503,
            );
          }
          return json({ sent: true });
        }
        return json({ error: "Unsupported action" }, 400);
      },
    },
  },
});
