import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { requireAuth, supabaseForCaller } from "../supabase";

export default defineTool({
  name: "list_pending_stock_requests",
  title: "List pending stock requests",
  description:
    "Returns stock requests the caller can see that are still awaiting approval or fulfillment. Respects row-level security.",
  inputSchema: {
    limit: z.number().int().min(1).max(100).optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    const auth = requireAuth(ctx);
    if (!auth.ok) return auth.response;
    const sb = supabaseForCaller(ctx);
    const { data, error } = await sb
      .from("stock_requests")
      .select("id, request_number, status, priority, notes, created_at, shop_id")
      .in("status", ["pending", "approved"])
      .order("created_at", { ascending: false })
      .limit(limit ?? 25);
    if (error) {
      return {
        content: [{ type: "text", text: `Query failed: ${error.message}` }],
        isError: true,
      };
    }
    const rows = data ?? [];
    return {
      content: [
        {
          type: "text",
          text: rows.length
            ? `${rows.length} open stock request(s):\n` +
              rows
                .map(
                  (r) =>
                    `- ${r.request_number ?? r.id} — ${r.status}${r.priority ? ` (${r.priority})` : ""}`,
                )
                .join("\n")
            : "No open stock requests.",
        },
      ],
      structuredContent: { requests: rows },
    };
  },
});
