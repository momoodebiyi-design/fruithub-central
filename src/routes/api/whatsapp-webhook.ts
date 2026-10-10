/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

async function hmacSha256(secret: string, value: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

type ProviderStatus = {
  id?: string;
  status?: "sent" | "delivered" | "read" | "failed";
  timestamp?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
};

function statusEvents(payload: any): ProviderStatus[] {
  if (!Array.isArray(payload?.entry)) return [];
  return payload.entry.flatMap((entry: any) =>
    Array.isArray(entry?.changes)
      ? entry.changes.flatMap((change: any) =>
          Array.isArray(change?.value?.statuses) ? change.value.statuses : [],
        )
      : [],
  );
}

type IncomingMessage = { id?: string; from?: string; type?: string; text?: { body?: string } };

function incomingMessages(payload: any): IncomingMessage[] {
  if (!Array.isArray(payload?.entry)) return [];
  return payload.entry.flatMap((entry: any) =>
    Array.isArray(entry?.changes)
      ? entry.changes.flatMap((change: any) =>
          Array.isArray(change?.value?.messages) ? change.value.messages : [],
        )
      : [],
  );
}

export const Route = createFileRoute("/api/whatsapp-webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim();

        if (mode === "subscribe" && expected && token === expected && challenge) {
          return new Response(challenge, { status: 200 });
        }
        return new Response("Webhook verification failed", { status: 403 });
      },
      POST: async ({ request }) => {
        const appSecret = process.env.WHATSAPP_APP_SECRET?.trim();
        if (!appSecret)
          return json({ error: "Webhook signature validation is not configured" }, 503);

        const rawBody = await request.text();
        const provided = request.headers.get("x-hub-signature-256")?.replace(/^sha256=/i, "");
        if (!provided) return json({ error: "Missing webhook signature" }, 401);
        const expected = await hmacSha256(appSecret, rawBody);
        if (!constantTimeEqual(expected, provided.toLowerCase())) {
          return json({ error: "Invalid webhook signature" }, 401);
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return json({ error: "Invalid webhook payload" }, 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as any;
        const rank: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 };
        let updated = 0;

        for (const event of statusEvents(payload)) {
          if (!event.id || !event.status) continue;
          const { data: briefingDelivery } = await admin
            .from("management_briefing_deliveries")
            .select("id, status")
            .eq("provider_message_id", event.id)
            .maybeSingle();
          if (briefingDelivery) {
            const shouldUpdateBriefing =
              event.status === "failed"
                ? !["delivered", "read"].includes(briefingDelivery.status)
                : (rank[event.status] ?? -1) >= (rank[briefingDelivery.status] ?? -1);
            if (shouldUpdateBriefing) {
              await admin
                .from("management_briefing_deliveries")
                .update({ status: event.status, updated_at: new Date().toISOString() })
                .eq("id", briefingDelivery.id);
              await admin.from("audit_log").insert({
                user_id: null,
                action: `management_briefing.whatsapp_${event.status}`,
                entity: "management_briefing_deliveries",
                entity_id: briefingDelivery.id,
                new_value: { provider_message_id: event.id },
              });
              updated += 1;
            }
            continue;
          }
          const { data: delivery } = await admin
            .from("purchase_notification_deliveries")
            .select("id, purchase_order_id, recipient_user_id, status")
            .eq("provider_message_id", event.id)
            .maybeSingle();
          if (!delivery) continue;

          const isFailure =
            event.status === "failed" && !["delivered", "read"].includes(delivery.status);
          const shouldUpdate =
            isFailure || (rank[event.status] ?? -1) >= (rank[delivery.status] ?? -1);
          if (!shouldUpdate) continue;

          const providerError = event.errors?.[0];
          const errorText = providerError
            ? [providerError.code, providerError.title, providerError.message]
                .filter(Boolean)
                .join(" · ")
            : null;
          const occurredAt = event.timestamp
            ? new Date(Number(event.timestamp) * 1000).toISOString()
            : new Date().toISOString();

          await admin
            .from("purchase_notification_deliveries")
            .update({
              status: event.status,
              last_error: errorText,
              sent_at: event.status === "sent" ? occurredAt : undefined,
              updated_at: new Date().toISOString(),
            })
            .eq("id", delivery.id);
          await admin.from("audit_log").insert({
            user_id: null,
            action: `purchase_notification.whatsapp_${event.status}`,
            entity: "purchase_notification_deliveries",
            entity_id: delivery.id,
            new_value: {
              purchase_order_id: delivery.purchase_order_id,
              recipient_user_id: delivery.recipient_user_id,
              provider_message_id: event.id,
              provider_timestamp: occurredAt,
              error: errorText,
            },
          });
          updated += 1;
        }

        // Only a verified, enrolled Super Admin phone can request the read-only
        // briefing. Other WhatsApp conversations are deliberately ignored.
        let replied = 0;
        const {
          normalisePhone,
          previousLagosDate,
          buildManagementBriefing,
          createBriefingDelivery,
          sendWhatsAppBriefing,
        } = await import("@/lib/management-briefing.server");
        for (const message of incomingMessages(payload)) {
          const command = message.text?.body?.trim().toLowerCase();
          if (
            !message.id ||
            !message.from ||
            message.type !== "text" ||
            !["briefing", "stop", "unsubscribe"].includes(command ?? "")
          )
            continue;
          const { data: pilot } = await admin
            .from("management_briefing_pilot")
            .select("user_id")
            .eq("enabled", true)
            .maybeSingle();
          if (!pilot) continue;
          const [{ data: profile }, { data: roles }] = await Promise.all([
            admin.from("profiles").select("phone,is_active").eq("id", pilot.user_id).maybeSingle(),
            admin.from("user_roles").select("role").eq("user_id", pilot.user_id),
          ]);
          const country = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE?.replace(/\D/g, "") || "234";
          if (
            !profile?.is_active ||
            !roles?.some((row: { role: string }) => row.role === "super_admin") ||
            normalisePhone(profile.phone ?? "", country) !== normalisePhone(message.from, country)
          )
            continue;

          if (command === "stop" || command === "unsubscribe") {
            await admin
              .from("management_briefing_pilot")
              .update({ enabled: false, updated_at: new Date().toISOString() })
              .eq("user_id", pilot.user_id)
              .eq("enabled", true);
            await admin.from("audit_log").insert({
              user_id: pilot.user_id,
              action: "management_briefing.pilot_disabled_by_whatsapp",
              entity: "management_briefing_pilot",
              entity_id: pilot.user_id,
              new_value: { inbound_message_id: message.id },
            });
            continue;
          }

          const reportDate = previousLagosDate();
          const id = await createBriefingDelivery(
            pilot.user_id,
            reportDate,
            "whatsapp_request",
            message.id,
          );
          if (!id) continue; // Meta redelivery of the same incoming message.
          try {
            const briefing = await buildManagementBriefing(reportDate);
            const sent = await sendWhatsAppBriefing(
              id,
              pilot.user_id,
              briefing,
              "whatsapp_request",
              new URL(request.url).origin,
              message.from,
            );
            if (sent) replied += 1;
          } catch {
            /* Failed delivery and audit are recorded by the send service. */
          }
        }

        return json({ received: true, updated, replied });
      },
    },
  },
});
