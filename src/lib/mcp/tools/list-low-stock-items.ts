import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { requireAuth, supabaseForCaller } from "../supabase";

export default defineTool({
  name: "list_low_stock_items",
  title: "List low-stock inventory items",
  description:
    "Returns inventory items whose current quantity is at or below their reorder threshold. Results respect the caller's row-level security.",
  inputSchema: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of items to return (default 25)."),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    const auth = requireAuth(ctx);
    if (!auth.ok) return auth.response;
    const sb = supabaseForCaller(ctx);
    const { data, error } = await (sb as any)
      .from("v_item_stock")
      .select("item_id, sku, name, unit, on_hand, reorder_level, category")
      .not("reorder_level", "is", null)
      .order("on_hand", { ascending: true })
      .limit(limit ?? 25);
    if (error) {
      return {
        content: [{ type: "text", text: `Query failed: ${error.message}` }],
        isError: true,
      };
    }
    const rows = (data ?? []) as Array<{
      item_id: string; sku: string; name: string; unit: string;
      on_hand: number | null; reorder_level: number | null; category: string | null;
    }>;
    const low = rows.filter(
      (r) => r.reorder_level != null && Number(r.on_hand ?? 0) <= Number(r.reorder_level),
    );
    return {
      content: [
        {
          type: "text",
          text: low.length
            ? `${low.length} low-stock item(s):\n` +
              low
                .map(
                  (r) =>
                    `- ${r.name} (${r.sku}) — ${Number(r.on_hand ?? 0)} ${r.unit} (reorder at ${r.reorder_level})`,
                )
                .join("\n")
            : "No items are at or below reorder level.",
        },
      ],
      structuredContent: { items: low },
    };

  },
});
