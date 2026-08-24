import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/profile")({
  component: ProfilePage,
});

function ProfilePage() {
  const [fullName, setFullName] = useState("");
  const [department, setDepartment] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      setEmail(u.user.email ?? "");
      const { data } = await supabase
        .from("profiles")
        .select("full_name, department, phone")
        .eq("id", u.user.id)
        .maybeSingle();
      if (data) {
        setFullName(data.full_name ?? "");
        setDepartment(data.department ?? "");
        setPhone(data.phone ?? "");
      }
    })();
  }, []);

  async function save() {
    setSaving(true);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setSaving(false);
      return;
    }
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: fullName, department, phone })
      .eq("id", u.user.id);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Profile updated");
  }

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
      <div className="space-y-4 bg-card ring-1 ring-black/5 rounded-lg p-6">
        <div>
          <Label>Email</Label>
          <Input value={email} disabled />
        </div>
        <div>
          <Label>Full name</Label>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div>
          <Label>Department</Label>
          <Input value={department} onChange={(e) => setDepartment(e.target.value)} />
        </div>
        <div>
          <Label>WhatsApp number</Label>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+234 801 234 5678"
            inputMode="tel"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Management approval alerts use this number. Include the country code where possible.
          </p>
        </div>
        <Button
          onClick={save}
          disabled={saving}
          className="bg-brand-orange text-white hover:bg-brand-orange/90"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
