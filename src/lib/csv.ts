/** Quote CSV fields and neutralise spreadsheet formulas in untrusted text. */
export function escapeCsv(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Preserve real numeric measures (including negative stock variances).
  // Spreadsheet applications can ignore leading whitespace/control characters.
  // eslint-disable-next-line no-control-regex -- explicitly detect malicious leading controls
  if (typeof value !== "number" && /^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}
