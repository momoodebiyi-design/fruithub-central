import { defineMcp } from "@lovable.dev/mcp-js";
import pingTool from "./tools/ping";

export default defineMcp({
  name: "juicery-ops-mcp",
  title: "Juicery Ops MCP",
  version: "0.1.0",
  instructions:
    "Public MCP server for Juicery Ops. Use `ping` to verify connectivity. This server intentionally exposes no operational data — all inventory, shop, sales, and recipe data remains behind row-level security and is not reachable without authentication.",
  tools: [pingTool],
});
