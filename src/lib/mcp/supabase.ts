import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ToolContext } from "@lovable.dev/mcp-js";

/** Supabase client that runs every query as the MCP caller (RLS applies). */
export function supabaseForCaller(ctx: ToolContext): SupabaseClient {
  const token = ctx.getToken();
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

export function requireAuth(ctx: ToolContext) {
  if (!ctx.isAuthenticated()) {
    return {
      ok: false as const,
      response: {
        content: [{ type: "text" as const, text: "Not authenticated." }],
        isError: true,
      },
    };
  }
  return { ok: true as const };
}
