import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { isEarlierLagosDay, lagosDateTimeInput } from "@/lib/operational-dates";

export function OperationalDateField({
  label,
  value,
  onChange,
  lateEntryReason,
  onLateEntryReasonChange,
  canBackdate,
  overrideLaterCount,
  onOverrideLaterCountChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  lateEntryReason: string;
  onLateEntryReasonChange: (value: string) => void;
  canBackdate: boolean;
  overrideLaterCount?: boolean;
  onOverrideLaterCountChange?: (value: boolean) => void;
}) {
  const enteredLate = isEarlierLagosDay(value);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <Label>{label} (Lagos time)</Label>
      <Input
        type="datetime-local"
        value={value}
        max={lagosDateTimeInput()}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        When it happened. The app separately records when you entered it.
        {!canBackdate && " Earlier-day entries require Management or Admin."}
      </p>
      {(enteredLate || overrideLaterCount) && (
        <div className="space-y-2">
          <Label>
            {enteredLate ? "Why is this being entered late?" : "Why override the later count?"}
          </Label>
          <Textarea
            value={lateEntryReason}
            onChange={(event) => onLateEntryReasonChange(event.target.value)}
            placeholder="For example: the paper record was entered the next morning"
            disabled={!canBackdate}
          />
        </div>
      )}
      {canBackdate && onOverrideLaterCountChange && (
        <label className="flex items-start gap-2 text-xs">
          <Checkbox
            checked={overrideLaterCount ?? false}
            onCheckedChange={(value) => onOverrideLaterCountChange(value === true)}
          />
          <span>
            Management override: if a later Central count covers this item, record the historic
            event but keep that later count authoritative for today’s stock. The override and reason
            will be audited.
          </span>
        </label>
      )}
    </div>
  );
}
