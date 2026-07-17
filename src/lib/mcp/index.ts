import { auth, defineMcp } from "@lovable.dev/mcp-js";
import pingTool from "./tools/ping";
import listLowStockTool from "./tools/list-low-stock-items";
import listPendingStockRequestsTool from "./tools/list-pending-stock-requests";
import searchInventoryItemsTool from "./tools/search-inventory-items";

// OAuth issuer MUST be the direct Supabase host, never the .lovable.cloud proxy.
// The project ref is the one Supabase value that survives publish unchanged.
const projectRef =
  import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "juicery-ops-mcp",
  title: "Juicery Ops MCP",
  version: "0.2.0",
  instructions:
    "Juicery Ops MCP server. Tools act as the signed-in Juicery Ops user and respect row-level security, so callers only see data their account is allowed to see. Use `ping` to verify connectivity, `search_inventory_items` to look up items, `list_low_stock_items` for reorder alerts, and `list_pending_stock_requests` for open shop requests.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    pingTool,
    searchInventoryItemsTool,
    listLowStockTool,
    listPendingStockRequestsTool,
  ],
});
