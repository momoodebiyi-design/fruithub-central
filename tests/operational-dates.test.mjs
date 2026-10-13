import assert from "node:assert/strict";
import test from "node:test";
import {
  lagosDateTimeInput,
  lagosInputToUtc,
  validatedOperationalDate,
} from "../src/lib/operational-dates.ts";

test("Lagos local event time is stored as an unambiguous UTC timestamp", () => {
  assert.equal(lagosInputToUtc("2026-10-12T08:30"), "2026-10-12T07:30:00.000Z");
  assert.equal(lagosDateTimeInput(new Date("2026-10-12T07:30:00Z")), "2026-10-12T08:30");
  assert.equal(lagosInputToUtc("2026-02-30T08:30"), null);
});

test("late entry requires a manager and a reason", () => {
  assert.throws(
    () => validatedOperationalDate("2020-01-01T09:00", "Late paper record", false),
    /Management or Admin/,
  );
  assert.throws(() => validatedOperationalDate("2020-01-01T09:00", "", true), /Explain/);
  assert.equal(
    validatedOperationalDate("2020-01-01T09:00", "Paper record entered later", true)
      .lateEntryReason,
    "Paper record entered later",
  );
});

test("manager override is explicit and reasoned, including for a same-day count", () => {
  const nowLocal = lagosDateTimeInput();
  assert.throws(() => validatedOperationalDate(nowLocal, "", true, true), /Explain/);
  assert.throws(
    () => validatedOperationalDate(nowLocal, "Manager reconciled", false, true),
    /Only Management/,
  );
  assert.equal(
    validatedOperationalDate(nowLocal, "Manager reconciled", true, true).lateEntryReason,
    "Manager reconciled",
  );
});

test("future events are rejected", () => {
  assert.throws(() => validatedOperationalDate("2099-01-01T09:00", "", true), /not in the future/);
});
