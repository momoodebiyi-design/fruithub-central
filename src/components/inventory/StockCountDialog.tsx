import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchStockLocations, StockLocation, StockReadError } from "@/lib/stock";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useSession } from "@/hooks/useSession";
import { CAN_BACKDATE_OPERATIONS, hasAny } from "@/lib/permissions";
import {
  lagosDateTimeInput,
  lagosInputToUtc,
  validatedOperationalDate,
} from "@/lib/operational-dates";
import { OperationalDateField } from "@/components/shared/OperationalDateField";

export function StockCountDialog({
  item,
  onClose,
  onSaved,
}: {
  item: { id: string; name: string; sku: string; unit: string; quantity: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { roles } = useSession();
  const canBackdate = hasAny(roles, CAN_BACKDATE_OPERATIONS);
  const [count, setCount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [occurredLocal, setOccurredLocal] = useState(lagosDateTimeInput);
  const [lateEntryReason, setLateEntryReason] = useState("");
  const [overrideLaterCount, setOverrideLaterCount] = useState(false);
  const [clientReferenceId] = useState(() => crypto.randomUUID());
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [locationId, setLocationId] = useState<string>("");
  const [system, setSystem] = useState<number | null>(null);
  const [loadingSystem, setLoadingSystem] = useState(false);
  const [systemError, setSystemError] = useState<string | null>(null);

  useEffect(() => {
    fetchStockLocations()
      .then((locs) => {
        setLocations(locs);
        const def = locs.find((l) => l.is_default) ?? locs[0];
        if (def) setLocationId(def.id);
      })
      .catch((e) =>
        toast.error(e instanceof StockReadError ? e.message : "Unable to load locations"),
      );
  }, []);

  useEffect(() => {
    if (!locationId) return;
    let cancelled = false;
    setLoadingSystem(true);
    setSystemError(null);
    const occurredAt = lagosInputToUtc(occurredLocal);
    if (!occurredAt) {
      setSystemError("Select a valid count date");
      setLoadingSystem(false);
      return;
    }
    // The RPC is introduced by the accompanying migration, ahead of generated types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .rpc("preview_stock_on_hand_at", {
        _item_id: item.id,
        _location_id: locationId,
        _occurred_at: occurredAt,
        _override_later_count: overrideLaterCount,
        _late_entry_reason: lateEntryReason || null,
      })
      .then(({ data, error }: { data: number | null; error: { message: string } | null }) => {
        if (error) throw error;
        if (!cancelled) {
          setSystem(Number(data ?? 0));
          setLoadingSystem(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setSystem(null);
          setLoadingSystem(false);
          setSystemError(
            e instanceof Error ? e.message : "Unable to load historical ledger balance",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, locationId, occurredLocal, overrideLaterCount, lateEntryReason]);

  const physical = Number(count);
  const delta = count === "" || system === null ? 0 : physical - system;

  async function save() {
    if (!locationId) return toast.error("Select a stock location");
    if (loadingSystem)
      return toast.error("Still reading stock at the count time — try again in a moment");
    if (systemError !== null || system === null)
      return toast.error("Cannot record adjustment without a ledger balance");
    if (count === "" || Number.isNaN(physical) || physical < 0)
      return toast.error("Enter a physical count (0 or more)");
    if (!reason.trim()) return toast.error("Add a reason for the adjustment");
    let actualDate: ReturnType<typeof validatedOperationalDate>;
    try {
      actualDate = validatedOperationalDate(
        occurredLocal,
        lateEntryReason,
        canBackdate,
        overrideLaterCount,
      );
    } catch (error) {
      return toast.error(error instanceof Error ? error.message : "Invalid count date");
    }

    setSaving(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("record_location_stock_count_with_date", {
      _item_id: item.id,
      _location_id: locationId,
      _physical_qty: physical,
      _reason: reason.trim(),
      _occurred_at: actualDate.occurredAt,
      _late_entry_reason: actualDate.lateEntryReason,
      _client_reference_id: clientReferenceId,
      _override_later_count: overrideLaterCount,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Stock count recorded");
    onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Stock count / audit</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="bg-muted rounded-md p-3">
            <p className="text-sm font-medium">{item.name}</p>
            <p className="text-xs text-muted-foreground font-mono">{item.sku}</p>
          </div>
          <div>
            <Label>Location</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose location…" />
              </SelectTrigger>
              <SelectContent>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                    {l.is_default ? " (default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>System at count time</Label>
              <Input
                value={
                  loadingSystem
                    ? "…"
                    : systemError !== null || system === null
                      ? "Unavailable"
                      : `${system.toLocaleString()} ${item.unit}`
                }
                readOnly
                className="font-mono"
              />
              {systemError !== null && !loadingSystem && (
                <p className="text-[11px] text-brand-orange mt-1">Unable to load ledger balance</p>
              )}
            </div>
            <div>
              <Label>Physical count</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={count}
                onChange={(e) => setCount(e.target.value)}
                placeholder="Actual on shelf"
              />
            </div>
          </div>
          <OperationalDateField
            label="Date and time physically counted"
            value={occurredLocal}
            onChange={setOccurredLocal}
            lateEntryReason={lateEntryReason}
            onLateEntryReasonChange={setLateEntryReason}
            canBackdate={canBackdate}
            overrideLaterCount={overrideLaterCount}
            onOverrideLaterCountChange={setOverrideLaterCount}
          />
          {count !== "" && system !== null && (
            <div className="text-sm">
              Difference:{" "}
              <span
                className={`font-mono font-semibold ${delta === 0 ? "" : delta > 0 ? "text-brand-green" : "text-brand-orange"}`}
              >
                {delta > 0 ? "+" : ""}
                {delta.toLocaleString()} {item.unit}
              </span>
            </div>
          )}
          <div>
            <Label>Reason</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Breakage, miscount, theft, expiry cleared, etc."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={
              saving || !locationId || loadingSystem || systemError !== null || system === null
            }
            className="bg-brand-orange text-white hover:bg-brand-orange/90"
          >
            {saving ? "Recording…" : "Record count"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
