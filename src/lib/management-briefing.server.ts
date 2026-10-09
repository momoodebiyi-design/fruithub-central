/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalisePhone, previousLagosDate, reportBounds } from "./management-briefing-utils";
export {
  lagosDate,
  normalisePhone,
  previousLagosDate,
  reportBounds,
} from "./management-briefing-utils";

const admin = supabaseAdmin as any;

export async function authorisedUser(token: string, roles: string[]) {
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  const userId = data.user.id;
  const [{ data: profile }, { data: userRoles }] = await Promise.all([
    admin.from("profiles").select("id, phone, is_active").eq("id", userId).maybeSingle(),
    admin.from("user_roles").select("role").eq("user_id", userId),
  ]);
  if (!profile?.is_active || !(userRoles ?? []).some((row: any) => roles.includes(row.role))) {
    return null;
  }
  return profile as { id: string; phone: string | null; is_active: boolean };
}

type Metric = number | null;
export type ManagementBriefing = {
  reportDate: string;
  asOf: string;
  productionBatches: Metric;
  dispatches: Metric;
  returns: Metric;
  stocktakesPosted: Metric;
  uncountedStocktakeLines: Metric;
  pendingPurchaseApprovals: Metric;
  lowStock: Array<{ name: string; onHand: number; reorderLevel: number; critical: boolean }> | null;
  warnings: string[];
};

async function countQuery(
  query: PromiseLike<{ count: number | null; error: any }>,
): Promise<Metric> {
  const { count, error } = await query;
  return error ? null : (count ?? 0);
}

export async function buildManagementBriefing(
  reportDate = previousLagosDate(),
): Promise<ManagementBriefing> {
  const { start, end } = reportBounds(reportDate);
  const [productionBatches, dispatches, returns, stocktakeResult, pendingPurchaseApprovals] =
    await Promise.all([
      countQuery(
        admin
          .from("production_batches")
          .select("id", { count: "exact", head: true })
          .in("status", ["completed", "qc_passed"])
          .gte("produced_at", start)
          .lt("produced_at", end),
      ),
      countQuery(
        admin
          .from("dispatches")
          .select("id", { count: "exact", head: true })
          .gte("dispatched_at", start)
          .lt("dispatched_at", end),
      ),
      countQuery(
        admin
          .from("dispatch_returns")
          .select("id", { count: "exact", head: true })
          .gte("recorded_at", start)
          .lt("recorded_at", end),
      ),
      admin
        .from("central_stocktakes")
        .select("id")
        .in("status", ["submitted", "approved"])
        .gte("submitted_at", start)
        .lt("submitted_at", end),
      countQuery(
        admin
          .from("purchase_orders")
          .select("id", { count: "exact", head: true })
          .eq("workflow_status", "awaiting_approval"),
      ),
    ]);
  const stocktakesPosted: Metric = stocktakeResult.error
    ? null
    : (stocktakeResult.data ?? []).length;
  const stocktakeIds = (stocktakeResult.data ?? []).map((row: { id: string }) => row.id);
  const uncountedStocktakeLines: Metric =
    stocktakeResult.error || stocktakeIds.length === 0
      ? null
      : await countQuery(
          admin
            .from("central_stocktake_lines")
            .select("id", { count: "exact", head: true })
            .in("stocktake_id", stocktakeIds)
            .is("counted_quantity", null),
        );

  const warnings: string[] = [];
  if (
    [productionBatches, dispatches, returns, stocktakesPosted, pendingPurchaseApprovals].some(
      (x) => x === null,
    ) ||
    (stocktakeIds.length > 0 && uncountedStocktakeLines === null)
  ) {
    warnings.push("Some source records could not be read; unavailable figures are not zero.");
  }
  if (stocktakesPosted === 0)
    warnings.push("No submitted Central stocktake was found for this date.");
  if (uncountedStocktakeLines !== null && uncountedStocktakeLines > 0)
    warnings.push(`${uncountedStocktakeLines} Central stocktake lines were not counted.`);

  let lowStock: ManagementBriefing["lowStock"] = null;
  const { data: locations, error: centralError } = await admin
    .from("locations")
    .select("id,name,is_default")
    .eq("status", "active")
    .limit(100);
  const central =
    (locations ?? []).find((row: any) => row.is_default) ??
    (locations ?? []).find((row: any) => String(row.name).toLowerCase() === "main store");
  if (centralError || !central) {
    warnings.push("Central location or stock data is unavailable.");
  } else {
    const [{ data: policies, error: policiesError }, { data: balances, error: balancesError }] =
      await Promise.all([
        admin
          .from("stock_level_policies")
          .select("item_id,critical_level,reorder_level,inventory_items(name)")
          .eq("location_id", central.id)
          .eq("is_active", true),
        admin.from("v_item_location_stock").select("item_id,on_hand").eq("location_id", central.id),
      ]);
    if (policiesError || balancesError) {
      warnings.push("Configured Central stock alerts are unavailable.");
    } else {
      const onHand = new Map<string, number>(
        (balances ?? []).map((row: any) => [row.item_id, Number(row.on_hand)]),
      );
      lowStock = (policies ?? [])
        .flatMap((policy: any) => {
          const quantity = onHand.get(policy.item_id) ?? 0;
          const reorder = Number(policy.reorder_level);
          if (quantity > reorder) return [];
          const item = Array.isArray(policy.inventory_items)
            ? policy.inventory_items[0]
            : policy.inventory_items;
          return [
            {
              name: item?.name ?? "Unknown item",
              onHand: quantity,
              reorderLevel: reorder,
              critical: quantity <= Number(policy.critical_level),
            },
          ];
        })
        .sort(
          (a: any, b: any) =>
            Number(b.critical) - Number(a.critical) || a.name.localeCompare(b.name),
        );
    }
  }

  return {
    reportDate,
    asOf: new Date().toISOString(),
    productionBatches,
    dispatches,
    returns,
    stocktakesPosted,
    uncountedStocktakeLines,
    pendingPurchaseApprovals,
    lowStock,
    warnings,
  };
}

function label(value: Metric) {
  return value === null ? "unavailable" : String(value);
}

export function briefingSummary(briefing: ManagementBriefing) {
  const low = briefing.lowStock === null ? "unavailable" : String(briefing.lowStock.length);
  const caution = briefing.warnings.length
    ? " Data warning: open the app to review missing or incomplete records."
    : "";
  return `Production batches ${label(briefing.productionBatches)}; dispatches ${label(briefing.dispatches)}; returns ${label(briefing.returns)}; Central stocktakes posted ${label(briefing.stocktakesPosted)}; uncounted lines ${label(briefing.uncountedStocktakeLines)}; low-stock items ${low}; purchase approvals awaiting action ${label(briefing.pendingPurchaseApprovals)}.${caution}`;
}

export async function sendWhatsAppBriefing(
  deliveryId: string,
  recipientId: string,
  briefing: ManagementBriefing,
  triggerType: "scheduled" | "whatsapp_request" | "in_app_request",
  appUrl: string,
  verifiedIncomingPhone?: string,
) {
  const [{ data: pilot }, { data: roles }] = await Promise.all([
    admin
      .from("management_briefing_pilot")
      .select("enabled")
      .eq("user_id", recipientId)
      .maybeSingle(),
    admin.from("user_roles").select("role").eq("user_id", recipientId),
  ]);
  if (!pilot?.enabled || !roles?.some((row: { role: string }) => row.role === "super_admin")) {
    throw new Error("The Super Admin briefing pilot is not enabled");
  }
  const phoneNumberId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID?.trim();
  const token = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN?.trim();
  const templateName = process.env.WHATSAPP_BRIEFING_TEMPLATE_NAME?.trim();
  const version = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || "v23.0";
  if (!phoneNumberId || !token || (triggerType !== "whatsapp_request" && !templateName)) {
    throw new Error("WhatsApp briefing credentials or approved template are not configured");
  }
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("phone,is_active")
    .eq("id", recipientId)
    .maybeSingle();
  const savedDestination =
    !profileError && profile?.is_active
      ? normalisePhone(
          profile.phone ?? "",
          process.env.WHATSAPP_DEFAULT_COUNTRY_CODE?.replace(/\D/g, "") || "234",
        )
      : null;
  if (!savedDestination)
    throw new Error("The enrolled Super Admin has no valid active WhatsApp number");
  const destination =
    verifiedIncomingPhone && triggerType === "whatsapp_request"
      ? normalisePhone(
          verifiedIncomingPhone,
          process.env.WHATSAPP_DEFAULT_COUNTRY_CODE?.replace(/\D/g, "") || "234",
        )
      : savedDestination;
  if (!destination || destination !== savedDestination) {
    throw new Error("The requesting WhatsApp number no longer matches the Super Admin profile");
  }

  const { data: claimed } = await admin
    .from("management_briefing_deliveries")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("id", deliveryId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (!claimed) return false;

  const reviewUrl = `${(process.env.APP_URL?.trim() || appUrl).replace(/\/$/, "")}/briefings`;
  const summary = briefingSummary(briefing);
  const message =
    triggerType === "whatsapp_request"
      ? {
          messaging_product: "whatsapp",
          to: destination,
          type: "text",
          text: {
            preview_url: false,
            body: `4ruit briefing for ${briefing.reportDate} (as of ${briefing.asOf}):\n${summary}\nReview: ${reviewUrl}`,
          },
        }
      : {
          messaging_product: "whatsapp",
          to: destination,
          type: "template",
          template: {
            name: templateName,
            language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE?.trim() || "en" },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: briefing.reportDate },
                  { type: "text", text: summary.slice(0, 900) },
                  { type: "text", text: reviewUrl },
                ],
              },
            ],
          },
        };

  try {
    const response = await fetch(
      `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(message),
      },
    );
    const result = (await response.json().catch(() => ({}))) as any;
    if (!response.ok || !result.messages?.[0]?.id) {
      throw new Error(result.error?.message ?? `WhatsApp returned ${response.status}`);
    }
    await admin
      .from("management_briefing_deliveries")
      .update({
        status: "sent",
        provider_message_id: result.messages[0].id,
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", deliveryId)
      .eq("status", "sending");
    await admin.from("audit_log").insert({
      user_id: recipientId,
      action: "management_briefing.whatsapp_sent",
      entity: "management_briefing_deliveries",
      entity_id: deliveryId,
      new_value: {
        report_date: briefing.reportDate,
        trigger_type: triggerType,
        provider_message_id: result.messages[0].id,
      },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "WhatsApp send failed";
    await admin
      .from("management_briefing_deliveries")
      .update({
        status: "failed",
        last_error: message.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("id", deliveryId)
      .eq("status", "sending");
    await admin.from("audit_log").insert({
      user_id: recipientId,
      action: "management_briefing.whatsapp_failed",
      entity: "management_briefing_deliveries",
      entity_id: deliveryId,
      new_value: {
        report_date: briefing.reportDate,
        trigger_type: triggerType,
        error: message.slice(0, 500),
      },
    });
    throw error;
  }
}

export async function createBriefingDelivery(
  recipientId: string,
  reportDate: string,
  triggerType: "scheduled" | "whatsapp_request" | "in_app_request",
  inboundMessageId?: string,
) {
  if (triggerType !== "scheduled") {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: limitError } = await admin
      .from("management_briefing_deliveries")
      .select("id", { count: "exact", head: true })
      .eq("recipient_user_id", recipientId)
      .gte("created_at", oneHourAgo)
      .neq("trigger_type", "scheduled");
    if (limitError) throw limitError;
    if ((count ?? 0) >= 5) return null;
  }
  const { data, error } = await admin
    .from("management_briefing_deliveries")
    .insert({
      recipient_user_id: recipientId,
      report_date: reportDate,
      trigger_type: triggerType,
      inbound_message_id: inboundMessageId ?? null,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      const query = admin
        .from("management_briefing_deliveries")
        .select("id,status")
        .eq("recipient_user_id", recipientId)
        .eq("report_date", reportDate)
        .eq("trigger_type", triggerType);
      const { data: existing } =
        triggerType === "whatsapp_request"
          ? await query.eq("inbound_message_id", inboundMessageId).maybeSingle()
          : await query.maybeSingle();
      return existing?.status === "pending" ? (existing.id as string) : null;
    }
    throw error;
  }
  return data?.id as string | null;
}
