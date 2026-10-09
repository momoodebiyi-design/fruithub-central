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
          lagosDate,
          previousLagosDate,
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
        const reportDate = previousLagosDate(now);
        const { data: pilot, error } = await admin
          .from("management_briefing_pilot")
          .select("user_id")
          .eq("enabled", true)
          .maybeSingle();
        if (error) return Response.json({ error: "Pilot setting unavailable" }, { status: 503 });
        if (!pilot) return Response.json({ status: "not_enrolled", date: lagosDate(now) });

        const id = await createBriefingDelivery(pilot.user_id, reportDate, "scheduled");
        if (!id) return Response.json({ status: "already_queued", reportDate });
        try {
          const briefing = await buildManagementBriefing(reportDate);
          const sent = await sendWhatsAppBriefing(
            id,
            pilot.user_id,
            briefing,
            "scheduled",
            new URL(request.url).origin,
          );
          return Response.json({ status: sent ? "sent" : "already_processing", reportDate });
        } catch (sendError) {
          return Response.json(
            { error: sendError instanceof Error ? sendError.message : "Briefing failed" },
            { status: 503 },
          );
        }
      },
    },
  },
});
