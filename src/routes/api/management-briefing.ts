/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export const Route = createFileRoute("/api/management-briefing")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Sign in required" }, 401);
        const [
          { authorisedUser, buildManagementBriefing, BRIEFING_MANAGEMENT_ROLES, normalisePhone },
          { supabaseAdmin },
        ] = await Promise.all([
          import("@/lib/management-briefing.server"),
          import("@/integrations/supabase/client.server"),
        ]);
        const user = await authorisedUser(token, [...BRIEFING_MANAGEMENT_ROLES]);
        if (!user) return json({ error: "Management access required" }, 403);
        const briefing = await buildManagementBriefing();
        const admin = supabaseAdmin as any;
        const [pilotResult, roleResult, profileResult, subscriptionResult] = await Promise.all([
          admin
            .from("management_briefing_pilot")
            .select("enabled,consented_at")
            .eq("user_id", user.id)
            .maybeSingle(),
          admin
            .from("user_roles")
            .select("user_id,role")
            .in("role", [...BRIEFING_MANAGEMENT_ROLES]),
          admin.from("profiles").select("id,phone").eq("is_active", true),
          admin.from("management_briefing_pilot").select("user_id").eq("enabled", true),
        ]);
        const eligibleIds = new Set(
          (roleResult.data ?? []).map((row: { user_id: string }) => row.user_id),
        );
        const activeManagement = (profileResult.data ?? []).filter((row: { id: string }) =>
          eligibleIds.has(row.id),
        );
        const optedInIds = new Set(
          (subscriptionResult.data ?? []).map((row: { user_id: string }) => row.user_id),
        );
        const readiness =
          roleResult.error || profileResult.error || subscriptionResult.error
            ? null
            : {
                activeManagement: activeManagement.length,
                withPhone: activeManagement.filter((row: { phone: string | null }) =>
                  Boolean(normalisePhone(row.phone ?? "")),
                ).length,
                optedIn: activeManagement.filter((row: { id: string }) => optedInIds.has(row.id))
                  .length,
              };
        return json({
          briefing,
          pilot: {
            enabled: pilotResult.data?.enabled === true,
            hasPhone: Boolean(normalisePhone(user.phone ?? "")),
          },
          readiness,
        });
      },
      POST: async ({ request }) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Sign in required" }, 401);
        const {
          authorisedUser,
          BRIEFING_MANAGEMENT_ROLES,
          normalisePhone,
          buildManagementBriefing,
          createBriefingDelivery,
          sendWhatsAppBriefing,
        } = await import("@/lib/management-briefing.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as any;
        const user = await authorisedUser(token, [...BRIEFING_MANAGEMENT_ROLES]);
        if (!user) return json({ error: "Management access required" }, 403);

        let body: { action?: string };
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid request" }, 400);
        }
        if (body.action === "enrol") {
          if (!normalisePhone(user.phone ?? ""))
            return json({ error: "Add a valid WhatsApp number to your profile first" }, 400);
          // A shared number cannot identify which user's stock briefing or
          // opt-out an incoming WhatsApp message belongs to.
          const { data: enabledSubscribers, error: subscribersError } = await admin
            .from("management_briefing_pilot")
            .select("user_id")
            .eq("enabled", true)
            .neq("user_id", user.id);
          if (subscribersError) return json({ error: "Unable to verify WhatsApp number" }, 503);
          if ((enabledSubscribers ?? []).length > 0) {
            const { data: otherProfiles, error: profilesError } = await admin
              .from("profiles")
              .select("id,phone,is_active")
              .in(
                "id",
                enabledSubscribers.map((row: { user_id: string }) => row.user_id),
              );
            if (profilesError) return json({ error: "Unable to verify WhatsApp number" }, 503);
            const thisPhone = normalisePhone(user.phone ?? "");
            if (
              (otherProfiles ?? []).some(
                (profile: { phone: string | null; is_active: boolean }) =>
                  profile.is_active && normalisePhone(profile.phone ?? "") === thisPhone,
              )
            )
              return json(
                { error: "This WhatsApp number is already enrolled by another management user" },
                409,
              );
          }
          const { error } = await admin.from("management_briefing_pilot").upsert(
            {
              user_id: user.id,
              enabled: true,
              consented_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" },
          );
          if (error) return json({ error: error.message }, 409);
          await admin.from("audit_log").insert({
            user_id: user.id,
            action: "management_briefing.subscription_enabled",
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
            action: "management_briefing.subscription_disabled",
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
          if (!pilot?.enabled) return json({ error: "Enable WhatsApp briefings first" }, 403);
          const briefing = await buildManagementBriefing();
          if (briefing.lowStock === null)
            return json({ error: "Low-stock report unavailable; nothing sent" }, 503);
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
