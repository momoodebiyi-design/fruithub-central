/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from "@tanstack/react-router";

const ALLOWED_ROLES = ["super_admin", "management", "operations_manager", "procurement"] as const;

type DispatchRequest = {
  action: "dispatch" | "retry";
  purchase_order_id: string;
};

type DeliveryRow = {
  id: string;
  purchase_order_id: string;
  recipient_user_id: string;
  destination: string | null;
  status: "pending" | "sending" | "sent" | "delivered" | "read" | "failed" | "skipped";
  attempt_count: number;
};

type OrderRow = {
  id: string;
  po_number: string;
  workflow_status: string;
  quoted_total: number;
  suppliers: { name: string } | null;
};

type OrderLine = {
  quantity_ordered: number;
  inventory_items: { name: string; unit: string } | null;
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function appOrigin(request: Request) {
  return (process.env.APP_URL?.trim() || new URL(request.url).origin).replace(/\/$/, "");
}

function normaliseWhatsAppNumber(value: string, defaultCountryCode: string) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && defaultCountryCode) {
    digits = `${defaultCountryCode}${digits.slice(1)}`;
  }
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

function quantity(value: number) {
  return Number(value).toLocaleString("en-NG", { maximumFractionDigits: 3 });
}

function requirementsSummary(lines: OrderLine[]) {
  const summary = lines
    .map((line) => {
      const item = line.inventory_items;
      return `${quantity(line.quantity_ordered)} ${item?.unit ?? "unit"} ${item?.name ?? "item"}`;
    })
    .join("; ");
  return summary.length > 700 ? `${summary.slice(0, 697)}...` : summary;
}

async function audit(
  admin: any,
  actorId: string,
  action: string,
  delivery: DeliveryRow,
  details: Record<string, unknown>,
) {
  await admin.from("audit_log").insert({
    user_id: actorId,
    action,
    entity: "purchase_notification_deliveries",
    entity_id: delivery.id,
    new_value: {
      purchase_order_id: delivery.purchase_order_id,
      recipient_user_id: delivery.recipient_user_id,
      channel: "whatsapp",
      ...details,
    },
  });
}

export const Route = createFileRoute("/api/purchase-notifications")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as any;
        const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

        if (!accessToken) return json({ error: "Sign in is required" }, 401);

        const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(accessToken);
        if (authError || !authData.user) return json({ error: "Your session has expired" }, 401);

        const actorId = authData.user.id;
        const [{ data: actorProfile }, { data: actorRoles }] = await Promise.all([
          supabaseAdmin.from("profiles").select("is_active").eq("id", actorId).maybeSingle(),
          supabaseAdmin.from("user_roles").select("role").eq("user_id", actorId),
        ]);
        const permitted = (actorRoles ?? []).some((row) =>
          ALLOWED_ROLES.includes(row.role as (typeof ALLOWED_ROLES)[number]),
        );
        if (!actorProfile?.is_active || !permitted) {
          return json({ error: "You do not have permission to send purchase alerts" }, 403);
        }

        let body: DispatchRequest;
        try {
          body = (await request.json()) as DispatchRequest;
        } catch {
          return json({ error: "Invalid request" }, 400);
        }
        if (
          !body ||
          !["dispatch", "retry"].includes(body.action) ||
          !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(body.purchase_order_id)
        ) {
          return json({ error: "A valid purchase order is required" }, 400);
        }

        const graphVersion = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || "v23.0";
        const phoneNumberId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID?.trim();
        const cloudToken = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN?.trim();
        const templateName =
          process.env.WHATSAPP_PURCHASE_TEMPLATE_NAME?.trim() || "purchase_approval_required";
        const templateLanguage = process.env.WHATSAPP_TEMPLATE_LANGUAGE?.trim() || "en";

        const missing = [
          ...(!phoneNumberId ? ["WHATSAPP_CLOUD_PHONE_NUMBER_ID"] : []),
          ...(!cloudToken ? ["WHATSAPP_CLOUD_ACCESS_TOKEN"] : []),
        ];
        if (missing.length) {
          return json({
            status: "setup_required",
            sent: 0,
            failed: 0,
            skipped: 0,
            message: `WhatsApp is queued but not configured. Add ${missing.join(" and ")}.`,
          });
        }

        const { data: orderData, error: orderError } = await admin
          .from("purchase_orders")
          .select("id, po_number, workflow_status, quoted_total, suppliers(name)")
          .eq("id", body.purchase_order_id)
          .maybeSingle();
        if (orderError || !orderData) return json({ error: "Purchase order not found" }, 404);
        const order = orderData as OrderRow;
        if (order.workflow_status !== "awaiting_approval") {
          return json({ error: "Only orders awaiting approval can send approval alerts" }, 409);
        }

        await admin
          .from("purchase_notification_deliveries")
          .update({
            status: "failed",
            last_error: "A previous send was interrupted and is ready to retry",
            updated_at: new Date().toISOString(),
          })
          .eq("purchase_order_id", body.purchase_order_id)
          .eq("channel", "whatsapp")
          .eq("status", "sending")
          .lt("last_attempt_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());

        const [{ data: lineData, error: lineError }, { data: deliveryData, error: deliveryError }] =
          await Promise.all([
            admin
              .from("purchase_order_items")
              .select("quantity_ordered, inventory_items(name, unit)")
              .eq("purchase_order_id", body.purchase_order_id)
              .order("created_at", { ascending: true }),
            admin
              .from("purchase_notification_deliveries")
              .select(
                "id, purchase_order_id, recipient_user_id, destination, status, attempt_count",
              )
              .eq("purchase_order_id", body.purchase_order_id)
              .eq("channel", "whatsapp")
              .in("status", ["pending", "failed", "skipped"]),
          ]);
        if (lineError) return json({ error: lineError.message }, 400);
        if (deliveryError) return json({ error: deliveryError.message }, 400);

        const lines = (lineData ?? []) as OrderLine[];
        const deliveries = (deliveryData ?? []) as DeliveryRow[];
        const reviewUrl = `${appOrigin(request)}/purchasing?order=${order.id}`;
        const summary = requirementsSummary(lines);
        const defaultCountryCode =
          process.env.WHATSAPP_DEFAULT_COUNTRY_CODE?.replace(/\D/g, "") || "234";
        const results = { sent: 0, failed: 0, skipped: 0, already_sent: 0 };

        if (deliveries.length === 0) {
          const { count } = await admin
            .from("purchase_notification_deliveries")
            .select("id", { count: "exact", head: true })
            .eq("purchase_order_id", order.id)
            .eq("channel", "whatsapp")
            .in("status", ["sent", "delivered", "read"]);
          results.already_sent = count ?? 0;
          return json({ status: "complete", ...results });
        }

        for (const delivery of deliveries) {
          const { data: profile } = await admin
            .from("profiles")
            .select("phone, is_active")
            .eq("id", delivery.recipient_user_id)
            .maybeSingle();
          const destination = profile?.is_active
            ? normaliseWhatsAppNumber(
                profile.phone ?? delivery.destination ?? "",
                defaultCountryCode,
              )
            : null;

          if (!destination) {
            const reason = profile?.is_active
              ? "Add a valid WhatsApp number to this management profile"
              : "Recipient profile is inactive";
            await admin
              .from("purchase_notification_deliveries")
              .update({
                destination: profile?.phone ?? delivery.destination,
                status: "skipped",
                last_error: reason,
                updated_at: new Date().toISOString(),
              })
              .eq("id", delivery.id);
            await audit(admin, actorId, "purchase_notification.whatsapp_skipped", delivery, {
              reason,
            });
            results.skipped += 1;
            continue;
          }

          const { data: claimed } = await admin
            .from("purchase_notification_deliveries")
            .update({
              destination,
              status: "sending",
              last_attempt_at: new Date().toISOString(),
              attempt_count: delivery.attempt_count + 1,
              last_error: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", delivery.id)
            .in("status", ["pending", "failed", "skipped"])
            .select("id")
            .maybeSingle();
          if (!claimed) continue;

          try {
            const response = await fetch(
              `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${cloudToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  messaging_product: "whatsapp",
                  recipient_type: "individual",
                  to: destination,
                  type: "template",
                  template: {
                    name: templateName,
                    language: { code: templateLanguage },
                    components: [
                      {
                        type: "body",
                        parameters: [
                          { type: "text", text: order.po_number },
                          { type: "text", text: order.suppliers?.name ?? "Supplier" },
                          {
                            type: "text",
                            text: `NGN ${Number(order.quoted_total).toLocaleString("en-NG")}`,
                          },
                          { type: "text", text: summary || "Open the order to review the items" },
                          { type: "text", text: reviewUrl },
                        ],
                      },
                    ],
                  },
                }),
              },
            );
            const provider = (await response.json().catch(() => ({}))) as {
              messages?: Array<{ id?: string }>;
              error?: { message?: string; code?: number };
            };
            if (!response.ok) {
              throw new Error(
                provider.error?.message || `WhatsApp Cloud API returned ${response.status}`,
              );
            }

            const providerMessageId = provider.messages?.[0]?.id ?? null;
            await admin
              .from("purchase_notification_deliveries")
              .update({
                status: "sent",
                provider_message_id: providerMessageId,
                last_error: null,
                sent_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", delivery.id)
              .eq("status", "sending");
            await audit(admin, actorId, "purchase_notification.whatsapp_sent", delivery, {
              provider_message_id: providerMessageId,
            });
            results.sent += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : "WhatsApp delivery failed";
            await admin
              .from("purchase_notification_deliveries")
              .update({
                status: "failed",
                last_error: message.slice(0, 1000),
                updated_at: new Date().toISOString(),
              })
              .eq("id", delivery.id)
              .eq("status", "sending");
            await audit(admin, actorId, "purchase_notification.whatsapp_failed", delivery, {
              error: message.slice(0, 1000),
            });
            results.failed += 1;
          }
        }

        return json({
          status: results.failed > 0 || results.skipped > 0 ? "attention_required" : "complete",
          ...results,
        });
      },
    },
  },
});
