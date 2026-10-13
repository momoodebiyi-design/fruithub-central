/** Browser values are entered in Lagos local time, not the viewer's device timezone. */
export function lagosDateTimeInput(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(" ", "T");
}

export function lagosInputToUtc(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}:00+01:00`);
  return Number.isNaN(parsed.getTime()) || lagosDateTimeInput(parsed) !== value
    ? null
    : parsed.toISOString();
}

export function isEarlierLagosDay(value: string) {
  return value.slice(0, 10) < lagosDateTimeInput().slice(0, 10);
}

export function validatedOperationalDate(
  localValue: string,
  lateEntryReason: string,
  canBackdate: boolean,
  overrideLaterCount = false,
) {
  const occurredAt = lagosInputToUtc(localValue);
  if (!occurredAt || new Date(occurredAt).getTime() > Date.now() + 5 * 60_000) {
    throw new Error("Choose an actual date and time that is not in the future");
  }
  const enteredLate = isEarlierLagosDay(localValue);
  if (enteredLate && !canBackdate) {
    throw new Error("Management or Admin must enter earlier-day records");
  }
  if (overrideLaterCount && !canBackdate) {
    throw new Error("Only Management or Admin may override a later count");
  }
  if ((enteredLate || overrideLaterCount) && lateEntryReason.trim().length < 5) {
    throw new Error("Explain the late entry or later-count override");
  }
  return {
    occurredAt,
    lateEntryReason: enteredLate || overrideLaterCount ? lateEntryReason.trim() : null,
  };
}
