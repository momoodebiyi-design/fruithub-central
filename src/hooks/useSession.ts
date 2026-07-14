import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/lib/permissions";

export interface SessionState {
  loading: boolean;
  user: User | null;
  roles: AppRole[];
  fullName: string | null;
  department: string | null;
  shopId: string | null;
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({
    loading: true,
    user: null,
    roles: [],
    fullName: null,
    department: null,
    shopId: null,
  });

  useEffect(() => {
    let mounted = true;

    async function hydrate(user: User | null) {
      if (!user) {
        if (mounted)
          setState({ loading: false, user: null, roles: [], fullName: null, department: null, shopId: null });
        return;
      }
      const [{ data: roleRows }, { data: profile }] = await Promise.all([
        supabase.from("user_roles").select("role").eq("user_id", user.id),
        supabase
          .from("profiles")
          .select("full_name, department, shop_id")
          .eq("id", user.id)
          .maybeSingle(),
      ]);
      if (!mounted) return;
      setState({
        loading: false,
        user,
        roles: (roleRows ?? []).map((r) => r.role as AppRole),
        fullName: profile?.full_name ?? null,
        department: profile?.department ?? null,
        shopId: (profile as { shop_id?: string | null } | null)?.shop_id ?? null,
      });
    }

    supabase.auth.getSession().then(({ data }) => hydrate(data.session?.user ?? null));

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        hydrate(session?.user ?? null);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
