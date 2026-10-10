const LAGOS_OFFSET = "+01:00";

export function lagosDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function previousLagosDate(now = new Date()): string {
  const date = new Date(`${lagosDate(now)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function reportBounds(reportDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error("Invalid report date");
  const next = new Date(`${reportDate}T00:00:00Z`);
  if (Number.isNaN(next.getTime()) || next.toISOString().slice(0, 10) !== reportDate) {
    throw new Error("Invalid report date");
  }
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    start: new Date(`${reportDate}T00:00:00${LAGOS_OFFSET}`).toISOString(),
    end: new Date(`${next.toISOString().slice(0, 10)}T00:00:00${LAGOS_OFFSET}`).toISOString(),
  };
}

export function normalisePhone(value: string, countryCode = "234") {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `${countryCode}${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}
