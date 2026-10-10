import test from "node:test";
import assert from "node:assert/strict";
import { escapeCsv } from "../src/lib/csv.ts";

test("untrusted formula-like text stays literal in every report", () => {
  for (const text of [
    '=HYPERLINK("https://example.com")',
    "+SUM(1,2)",
    "-1+2",
    "@SUM(1)",
    " \t=1+1",
    "\r\n+1",
    "\u0000=1",
  ]) {
    assert.ok(escapeCsv(text).startsWith("\"'"));
  }
});
test("CSV escaping preserves text, nulls and real numeric measures", () => {
  assert.equal(escapeCsv('Juice, "Orange"'), '"Juice, ""Orange"""');
  assert.equal(escapeCsv(null), '""');
  assert.equal(escapeCsv(-12.5), '"-12.5"');
  assert.equal(escapeCsv(0), '"0"');
  assert.equal(escapeCsv("FG-001"), '"FG-001"');
});
