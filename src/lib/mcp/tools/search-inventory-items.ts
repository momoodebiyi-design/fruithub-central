import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { requireAuth, supabaseForCaller } from "../supabase";

export default defineTool({
  name: "search_inventory_items",
  title: "Search inventory items",
  description:
    "Search inventory items by name or SKU. Returns current on-hand quantity and unit. Respects row-level security.",
  inputSchema: {
    query: z.string().min(1).describe("Search text matched against name and SKU."),
    limit: z.number().int().min(1).max(50).optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async ({ query, limit }, ctx) => {
    const auth = requireAuth(ctx);
    if (!auth.ok) return auth.response;
    const sb = supabaseForCaller(ctx);
    const like = `%${query.replace(/[%_]/g, "")}%`;
    const { data, error } = await sb
      .from("inventory_items")
      .select("id, sku, name, unit, quantity, category")
      .or(`name.ilike.${like},sku.ilike.${like}`)
      .limit(limit ?? 20);
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
            ? rows
                .map(
                  (r) =>
                    `- ${r.name} (${r.sku}) — ${r.quantity} ${r.unit}${r.category ? ` · ${r.category}` : ""}`,
                )
                .join("\n")
            : `No inventory items match "${query}".`,
        },
      ],
      structuredContent: { items: rows },
    };
  },
});
