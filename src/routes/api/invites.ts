import { createFileRoute } from "@tanstack/react-router";
import type { AppRole } from "@/lib/permissions";

const MANAGER_ROLES = ["super_admin", "admin"] as const;
const APP_ROLES: AppRole[] = [
  "super_admin",
  "admin",
  "management",
  "operations_manager",
  "inventory_officer",
  "procurement",
  "production",
  "event_team",
  "sales",
  "shop_supervisor",
  "readonly",
];

type InviteRequest =
  | {
      action: "create";
      email: string;
      role: AppRole;
      full_name?: string;
      department?: string;
    }
  | { action: "send_existing"; invite_id: string }
  | { action: "resend_confirmation"; user_id: string };

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "Unable to send the invitation email";
}

function redirectOrigin(request: Request) {
  const configured = process.env.APP_URL?.trim();
  return (configured || new URL(request.url).origin).replace(/\/$/, "");
}

export const Route = createFileRoute("/api/invites")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

        if (!accessToken) return json({ error: "Sign in is required" }, 401);

        const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(accessToken);
        if (authError || !authData.user) return json({ error: "Your session has expired" }, 401);

        const actorId = authData.user.id;
        const [{ data: actorProfile }, { data: managerRole }] = await Promise.all([
          supabaseAdmin.from("profiles").select("is_active").eq("id", actorId).maybeSingle(),
          supabaseAdmin
            .from("user_roles")
            .select("role")
            .eq("user_id", actorId)
            .in("role", [...MANAGER_ROLES])
            .limit(1)
            .maybeSingle(),
        ]);

        if (!actorProfile?.is_active || !managerRole) {
          return json({ error: "You do not have permission to manage invitations" }, 403);
        }

        let body: InviteRequest;
        try {
          body = (await request.json()) as InviteRequest;
        } catch {
          return json({ error: "Invalid request" }, 400);
        }

        if (!body || typeof body !== "object" || typeof body.action !== "string") {
          return json({ error: "Invalid request" }, 400);
        }

        const origin = redirectOrigin(request);

        if (body.action === "create") {
          const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
          const fullName =
            typeof body.full_name === "string" ? body.full_name.trim() || null : null;
          const department =
            typeof body.department === "string" ? body.department.trim() || null : null;

          if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
            return json({ error: "Enter a valid email address" }, 400);
          }
          if (!APP_ROLES.includes(body.role)) return json({ error: "Select a valid role" }, 400);

          const { data: existingProfile } = await supabaseAdmin
            .from("profiles")
            .select("id, is_active")
            .ilike("email", email)
            .maybeSingle();

          if (existingProfile) {
            return json(
              {
                error: existingProfile.is_active
                  ? "This person already has an active account"
                  : "This account already exists. Use Resend access email or Reactivate instead.",
              },
              409,
            );
          }

          const { data: pending } = await supabaseAdmin
            .from("user_invites")
            .select("id, token, send_count")
            .ilike("email", email)
            .is("accepted_at", null)
            .is("cancelled_at", null)
            .gt("expires_at", new Date().toISOString())
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          let invite = pending;
          if (pending) {
            const { data, error } = await supabaseAdmin
              .from("user_invites")
              .update({
                role: body.role,
                full_name: fullName,
                department,
                invited_by: actorId,
              })
              .eq("id", pending.id)
              .select("id, token, send_count")
              .single();
            if (error) return json({ error: error.message }, 400);
            invite = data;
          } else {
            const { data, error } = await supabaseAdmin
              .from("user_invites")
              .insert({
                email,
                role: body.role,
                full_name: fullName,
                department,
                invited_by: actorId,
                expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
              })
              .select("id, token, send_count")
              .single();
            if (error) return json({ error: error.message }, 400);
            invite = data;
          }

          try {
            const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
              redirectTo: `${origin}/reset-password?mode=invite`,
              data: {
                invite_token: invite.token,
                full_name: fullName,
              },
            });
            if (error) throw error;

            await Promise.all([
              supabaseAdmin
                .from("user_invites")
                .update({
                  email_sent_at: new Date().toISOString(),
                  send_count: invite.send_count + 1,
                  last_send_error: null,
                })
                .eq("id", invite.id),
              supabaseAdmin.from("audit_log").insert({
                user_id: actorId,
                action: "invite.email_sent",
                entity: "user_invites",
                entity_id: invite.id,
                new_value: { email, role: body.role },
              }),
            ]);

            return json({ ok: true, message: "Invitation email sent" });
          } catch (error) {
            const message = messageFrom(error);
            await supabaseAdmin
              .from("user_invites")
              .update({ last_send_error: message })
              .eq("id", invite.id);
            return json({ error: message }, 400);
          }
        }

        if (body.action === "send_existing") {
          if (!body.invite_id) return json({ error: "Invitation is required" }, 400);

          const { data: invite, error: inviteError } = await supabaseAdmin
            .from("user_invites")
            .select("id, email, token, full_name, role, send_count")
            .eq("id", body.invite_id)
            .is("accepted_at", null)
            .is("cancelled_at", null)
            .gt("expires_at", new Date().toISOString())
            .maybeSingle();

          if (inviteError || !invite)
            return json({ error: "Invitation is invalid or expired" }, 404);

          try {
            const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(invite.email, {
              redirectTo: `${origin}/reset-password?mode=invite`,
              data: { invite_token: invite.token, full_name: invite.full_name },
            });
            if (error) throw error;

            await Promise.all([
              supabaseAdmin
                .from("user_invites")
                .update({
                  email_sent_at: new Date().toISOString(),
                  send_count: invite.send_count + 1,
                  last_send_error: null,
                })
                .eq("id", invite.id),
              supabaseAdmin.from("audit_log").insert({
                user_id: actorId,
                action: "invite.email_resent",
                entity: "user_invites",
                entity_id: invite.id,
                new_value: { email: invite.email, role: invite.role },
              }),
            ]);
            return json({ ok: true, message: "Invitation email sent" });
          } catch (error) {
            const message = messageFrom(error);
            await supabaseAdmin
              .from("user_invites")
              .update({ last_send_error: message })
              .eq("id", invite.id);
            return json({ error: message }, 400);
          }
        }

        if (body.action === "resend_confirmation") {
          if (!body.user_id) return json({ error: "User is required" }, 400);

          const [{ data: userResult, error: userError }, { data: profile }] = await Promise.all([
            supabaseAdmin.auth.admin.getUserById(body.user_id),
            supabaseAdmin.from("profiles").select("email").eq("id", body.user_id).maybeSingle(),
          ]);

          const user = userResult?.user;
          if (userError || !user || !profile?.email) return json({ error: "User not found" }, 404);
          if (user.email_confirmed_at) {
            return json(
              { error: "This email is already confirmed. Reactivate the account instead." },
              409,
            );
          }

          const { error } = await supabaseAdmin.auth.resend({
            type: "signup",
            email: profile.email,
            options: { emailRedirectTo: `${origin}/auth?mode=signin` },
          });
          if (error) return json({ error: error.message }, 400);

          await supabaseAdmin.from("audit_log").insert({
            user_id: actorId,
            action: "user.confirmation_email_resent",
            entity: "profiles",
            entity_id: body.user_id,
            new_value: { email: profile.email },
          });
          return json({ ok: true, message: "Access email sent" });
        }

        return json({ error: "Unsupported action" }, 400);
      },
    },
  },
});
