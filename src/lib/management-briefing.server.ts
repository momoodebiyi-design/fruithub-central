/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { lagosDate, normalisePhone } from "./management-briefing-utils";
import {
  evaluateStockCoverage,
  type BriefingBalance,
  type BriefingItem,
  type BriefingLocation,
  type BriefingPolicy,
  type LowStockLine,
} from "./management-briefing-stock";
export {
  lagosDate,
  normalisePhone,
  previousLagosDate,
  reportBounds,
} from "./management-briefing-utils";

const admin = supabaseAdmin as any;

export const BRIEFING_MANAGEMENT_ROLES = [
  "super_admin",
  "management",
  "operations_manager",
] as const;

export function hasBriefingRole(roles: Array<{ role: string }> | null | undefined) {
  return Boolean(roles?.some((row) => BRIEFING_MANAGEMENT_ROLES.some((role) => role === row.role)));
}

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

export type ManagementBriefing = {
  reportDate: string;
  asOf: string;
  lowStock: LowStockLine[] | null;
  trackedPairs: number | null;
  configuredPairs: number | null;
  unconfiguredPairs: number | null;
  locationNames: string[];
  warnings: string[];
};

export async function buildManagementBriefing(
  reportDate = lagosDate(),
): Promise<ManagementBriefing> {
  const asOf = new Date().toISOString();
  const warnings: string[] = [];
  // Cover all active inventory locations. At shops, only pairs with an
  // existing balance or explicit policy are tracked; Central includes every
  // catalogue item. Missing policies remain unclassified, never "healthy".
  const scope: "central" | "all" = "all";
  const [itemResult, locationResult, policyResult, balanceResult] = await Promise.all([
    admin.from("inventory_items").select("id,sku,name,category,unit").eq("status", "active"),
    admin.from("locations").select("id,name,is_default").eq("status", "active"),
    admin
      .from("stock_level_policies")
      .select("item_id,location_id,critical_level,reorder_level")
      .eq("is_active", true),
    admin.from("v_item_location_stock").select("item_id,location_id,on_hand"),
  ]);
  if (itemResult.error || locationResult.error || policyResult.error || balanceResult.error) {
    warnings.push("Inventory, location, threshold or balance records could not be read.");
    return {
      reportDate,
      asOf,
      lowStock: null,
      trackedPairs: null,
      configuredPairs: null,
      unconfiguredPairs: null,
      locationNames: [],
      warnings,
    };
  }

  let coverage;
  try {
    coverage = evaluateStockCoverage({
      items: (itemResult.data ?? []) as BriefingItem[],
      locations: (locationResult.data ?? []) as BriefingLocation[],
      policies: (policyResult.data ?? []) as BriefingPolicy[],
      balances: (balanceResult.data ?? []) as BriefingBalance[],
      scope,
    });
  } catch {
    warnings.push("The active Central location could not be identified.");
    return {
      reportDate,
      asOf,
      lowStock: null,
      trackedPairs: null,
      configuredPairs: null,
      unconfiguredPairs: null,
      locationNames: [],
      warnings,
    };
  }

  if (coverage.unconfiguredPairs > 0) {
    warnings.push(
      `${coverage.unconfiguredPairs} tracked item/location pairs have no approved reorder policy; they are not classified as low stock.`,
    );
  }
  if (coverage.locationNames.length > 1) {
    warnings.push(
      "Shop balances may be stale while point-of-sale stock depletion is not active; verify shop counts before acting on them.",
    );
  }

  return {
    reportDate,
    asOf,
    lowStock: coverage.lowStock,
    trackedPairs: coverage.trackedPairs,
    configuredPairs: coverage.configuredPairs,
    unconfiguredPairs: coverage.unconfiguredPairs,
    locationNames: coverage.locationNames,
    warnings,
  };
}

export function briefingSummary(briefing: ManagementBriefing) {
  if (briefing.lowStock === null)
    return "Low-stock counts are unavailable. Open the app for the data warning.";
  const asOfLagos = new Date(briefing.asOf).toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const critical = briefing.lowStock.filter((line) => line.critical).length;
  const categoryCounts = new Map<string, number>();
  for (const line of briefing.lowStock) {
    categoryCounts.set(line.category, (categoryCounts.get(line.category) ?? 0) + 1);
  }
  const byCategory = [...categoryCounts]
    .map(([category, count]) => `${category.replaceAll("_", " ")} ${count}`)
    .join("; ");
  let summary = `${briefing.lowStock.length} low-stock item/location counts (${critical} critical) as of ${asOfLagos} Lagos.`;
  if (byCategory) summary += ` By category: ${byCategory}.`;
  if (briefing.unconfiguredPairs)
    summary += ` ${briefing.unconfiguredPairs} need reorder-level setup.`;
  if (briefing.lowStock.length === 0) return summary;

  let shown = 0;
  for (const line of briefing.lowStock) {
    const detail = ` ${line.locationName} / ${line.name}: ${line.onHand} ${line.unit} (reorder ${line.reorderLevel})${line.critical ? " CRITICAL" : ""}.`;
    // The approved template has one bounded summary placeholder. The app has
    // every line, while WhatsApp includes as many as fit without cutting one.
    if (summary.length + detail.length + 32 > 850) break;
    summary += detail;
    shown += 1;
  }
  if (shown < briefing.lowStock.length)
    summary += ` ${briefing.lowStock.length - shown} more in the app.`;
  return summary;
}

export async function sendWhatsAppBriefing(
  deliveryId: string,
  recipientId: string,
  briefing: ManagementBriefing,
  triggerType: "scheduled" | "whatsapp_request" | "in_app_request",
  appUrl: string,
  verifiedIncomingPhone?: string,
) {
  if (briefing.lowStock === null) {
    throw new Error("The low-stock report is unavailable; no WhatsApp briefing was sent");
  }
  const [{ data: pilot }, { data: roles }] = await Promise.all([
    admin
      .from("management_briefing_pilot")
      .select("enabled")
      .eq("user_id", recipientId)
      .maybeSingle(),
    admin.from("user_roles").select("role").eq("user_id", recipientId),
  ]);
  if (!pilot?.enabled || !hasBriefingRole(roles)) {
    throw new Error("WhatsApp briefings are not enabled for this active management user");
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
    throw new Error("The enrolled management user has no valid active WhatsApp number");
  const destination =
    verifiedIncomingPhone && triggerType === "whatsapp_request"
      ? normalisePhone(
          verifiedIncomingPhone,
          process.env.WHATSAPP_DEFAULT_COUNTRY_CODE?.replace(/\D/g, "") || "234",
        )
      : savedDestination;
  if (!destination || destination !== savedDestination) {
    throw new Error("The requesting WhatsApp number no longer matches the management profile");
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
            body: `4ruit low-stock briefing for ${briefing.reportDate}:\n${summary}\nFull report: ${reviewUrl}`,
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
