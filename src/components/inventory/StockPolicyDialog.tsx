/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

type Location = { id: string; name: string; location_type: string | null };
type Policy = {
  location_id: string;
  critical_level: number;
  reorder_level: number;
  target_level: number;
  source_type: string;
  source_location_id: string | null;
};

export function StockPolicyDialog({
  itemId,
  itemCategory,
  onClose,
  onSaved,
}: {
  itemId: string;
  itemCategory: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [locationId, setLocationId] = useState("");
  const [critical, setCritical] = useState("");
  const [reorder, setReorder] = useState("");
  const [target, setTarget] = useState("");
  const [route, setRoute] = useState("");
  const [sourceLocationId, setSourceLocationId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [{ data: locs }, { data: existing }] = await Promise.all([
        supabase
          .from("locations")
          .select("id, name, location_type")
          .eq("status", "active")
          .order("name"),
        (supabase as any)
          .from("stock_level_policies")
          .select(
            "location_id, critical_level, reorder_level, target_level, source_type, source_location_id",
          )
          .eq("item_id", itemId),
      ]);
      setLocations((locs as Location[]) ?? []);
      setPolicies((existing as Policy[]) ?? []);
    })();
  }, [itemId]);

  const selectedLocation = useMemo(
    () => locations.find((location) => location.id === locationId),
    [locations, locationId],
  );

  function selectLocation(id: string) {
    setLocationId(id);
    const existing = policies.find((policy) => policy.location_id === id);
    if (existing) {
      setCritical(String(existing.critical_level));
      setReorder(String(existing.reorder_level));
      setTarget(String(existing.target_level));
      setRoute(existing.source_type);
      setSourceLocationId(existing.source_location_id ?? "");
      return;
    }
    setCritical("");
    setReorder("");
    setTarget("");
    const location = locations.find((row) => row.id === id);
    const isShop =
      location?.location_type?.toLowerCase() === "shop" ||
      location?.name.toLowerCase().includes("shop");
    setRoute(
      isShop && itemCategory === "finished_good"
        ? "replenishment"
        : itemCategory === "finished_good"
          ? "production"
          : "purchasing",
    );
    setSourceLocationId(
      isShop ? (locations.find((row) => row.name === "Main Store")?.id ?? "") : "",
    );
  }

  async function save() {
    const criticalValue = Number(critical);
    const reorderValue = Number(reorder);
    const targetValue = Number(target);
    if (!locationId || !route || critical === "" || reorder === "" || target === "") {
      return toast.error("Location, route and all three thresholds are required");
    }
    if (!(targetValue > reorderValue && reorderValue >= criticalValue && criticalValue >= 0)) {
      return toast.error("Use target > reorder ≥ critical ≥ 0");
    }
    if (route === "replenishment" && !sourceLocationId) {
      return toast.error("Choose the Central source location");
    }
    setSaving(true);
    const { error } = await (supabase as any).rpc("upsert_stock_level_policy", {
      _item_id: itemId,
      _location_id: locationId,
      _critical_level: criticalValue,
      _reorder_level: reorderValue,
      _target_level: targetValue,
      _source_type: route,
      _source_location_id: route === "replenishment" ? sourceLocationId : null,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Stock policy saved and current balance evaluated");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Configure stock policy</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            No recommendation is created until these levels are deliberately configured for a
            location.
          </p>
          <div>
            <Label>Location</Label>
            <Select value={locationId} onValueChange={selectLocation}>
              <SelectTrigger>
                <SelectValue placeholder="Select location" />
              </SelectTrigger>
              <SelectContent>
                {locations.map((location) => (
                  <SelectItem key={location.id} value={location.id}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Critical</Label>
              <Input
                type="number"
                min="0"
                value={critical}
                onChange={(event) => setCritical(event.target.value)}
              />
            </div>
            <div>
              <Label>Reorder</Label>
              <Input
                type="number"
                min="0"
                value={reorder}
                onChange={(event) => setReorder(event.target.value)}
              />
            </div>
            <div>
              <Label>Target</Label>
              <Input
                type="number"
                min="0"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>When low, route to</Label>
            <Select
              value={route}
              onValueChange={(value) => {
                setRoute(value);
                if (value !== "replenishment") setSourceLocationId("");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select route" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="purchasing">Purchasing (external supplier)</SelectItem>
                <SelectItem value="production">Production need</SelectItem>
                <SelectItem value="replenishment">Replenishment (from Central)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {route === "replenishment" && (
            <div>
              <Label>Source location</Label>
              <Select value={sourceLocationId} onValueChange={setSourceLocationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent>
                  {locations
                    .filter((location) => location.id !== locationId)
                    .map((location) => (
                      <SelectItem key={location.id} value={location.id}>
                        {location.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {selectedLocation && (
            <p className="text-xs text-muted-foreground">
              Policy applies only to {selectedLocation.name}; it does not change other locations.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving}
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            {saving ? "Saving…" : "Save & evaluate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
