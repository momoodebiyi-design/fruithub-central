import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";

export default defineTool({
  name: "ping",
  title: "Ping",
  description:
    "Health check for the Juicery Ops MCP server. Returns 'pong' plus the current server time.",
  inputSchema: {
    message: z
      .string()
      .optional()
      .describe("Optional message echoed back with the pong response."),
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: ({ message }) => ({
    content: [
      {
        type: "text",
        text: `pong${message ? `: ${message}` : ""} (server time: ${new Date().toISOString()})`,
      },
    ],
  }),
});
