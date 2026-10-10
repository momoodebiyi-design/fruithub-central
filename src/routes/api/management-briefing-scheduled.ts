/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/management-briefing-scheduled")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.BRIEFING_CRON_SECRET?.trim();
        if (!secret || request.headers.get("x-briefing-cron-secret") !== secret) {
          return Response.json({ error: "Unauthorised" }, { status: 401 });
        }
        const {
          hasBriefingRole,
          lagosDate,
          normalisePhone,
          buildManagementBriefing,
          createBriefingDelivery,
          sendWhatsAppBriefing,
        } = await import("@/lib/management-briefing.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as any;
        const now = new Date();
        const lagosHour = Number(
          new Intl.DateTimeFormat("en-GB", {
            timeZone: "Africa/Lagos",
            hour: "2-digit",
            hourCycle: "h23",
          }).format(now),
        );
        if (lagosHour < 8 || lagosHour > 11)
          return Response.json(
            { error: "Scheduled briefings run in the Lagos morning window" },
            { status: 409 },
          );
        const reportDate = lagosDate(now);
        const { data: subscriptions, error } = await admin
          .from("management_briefing_pilot")
          .select("user_id")
          .eq("enabled", true);
        if (error) return Response.json({ error: "Subscriptions unavailable" }, { status: 503 });
        if (!subscriptions?.length)
          return Response.json({ status: "no_opted_in_recipients", reportDate });

        const ids = subscriptions.map((row: { user_id: string }) => row.user_id);
        const [{ data: profiles, error: profilesError }, { data: roles, error: rolesError }] =
          await Promise.all([
            admin.from("profiles").select("id,phone,is_active").in("id", ids),
            admin.from("user_roles").select("user_id,role").in("user_id", ids),
          ]);
        if (profilesError || rolesError)
          return Response.json({ error: "Recipient records unavailable" }, { status: 503 });
        const country = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE?.replace(/\D/g, "") || "234";
        const recipients = (profiles ?? []).filter(
          (profile: { id: string; phone: string | null; is_active: boolean }) =>
            profile.is_active &&
            Boolean(normalisePhone(profile.phone ?? "", country)) &&
            hasBriefingRole(
              (roles ?? []).filter(
                (role: { user_id: string; role: string }) => role.user_id === profile.id,
              ),
            ),
        );
        if (recipients.length === 0)
          return Response.json({
            status: "no_eligible_recipients",
            reportDate,
            skipped: ids.length,
          });

        const briefing = await buildManagementBriefing(reportDate);
        if (briefing.lowStock === null)
          return Response.json(
            { error: "Low-stock report unavailable; nothing sent" },
            { status: 503 },
          );
        let sent = 0;
        let failed = 0;
        let alreadyQueued = 0;
        for (const recipient of recipients) {
          try {
            const id = await createBriefingDelivery(recipient.id, reportDate, "scheduled");
            if (!id) {
              alreadyQueued += 1;
              continue;
            }
            if (
              await sendWhatsAppBriefing(
                id,
                recipient.id,
                briefing,
                "scheduled",
                new URL(request.url).origin,
              )
            )
              sent += 1;
          } catch {
            failed += 1; // The delivery row contains the provider error and audit event.
          }
        }
        return Response.json(
          {
            status: failed > 0 ? "partial_failure" : "processed",
            reportDate,
            sent,
            failed,
            alreadyQueued,
            skipped: ids.length - recipients.length,
          },
          { status: failed > 0 ? 503 : 200 },
        );
      },
    },
  },
});
