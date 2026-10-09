import test from "node:test";
import assert from "node:assert/strict";
import {
  lagosDate,
  previousLagosDate,
  reportBounds,
  normalisePhone,
} from "../src/lib/management-briefing-utils.ts";

test("briefing day follows Lagos calendar boundaries", () => {
  const beforeMidnight = new Date("2026-10-09T22:59:59Z");
  const afterMidnight = new Date("2026-10-09T23:00:00Z");
  assert.equal(lagosDate(beforeMidnight), "2026-10-09");
  assert.equal(lagosDate(afterMidnight), "2026-10-10");
  assert.equal(previousLagosDate(afterMidnight), "2026-10-09");
});

test("report bounds cover exactly the prior Lagos day", () => {
  assert.deepEqual(reportBounds("2026-10-09"), {
    start: "2026-10-08T23:00:00.000Z",
    end: "2026-10-09T23:00:00.000Z",
  });
  assert.throws(() => reportBounds("2026-02-30"));
});

test("saved Nigerian phone and incoming WhatsApp ID normalise identically", () => {
  assert.equal(normalisePhone("0803 123 4567"), "2348031234567");
  assert.equal(normalisePhone("+234 803 123 4567"), "2348031234567");
  assert.equal(normalisePhone("2348031234567"), "2348031234567");
  assert.equal(normalisePhone("not a phone"), null);
});
