import assert from "node:assert/strict";
import { test } from "node:test";
import { hourLabel, isValidTimezone, localDate, nextOccurrence, previousDate } from "../src/time.js";

test("localDate uses the server's timezone, not UTC", () => {
  const lateEvening = new Date("2026-09-30T03:30:00Z"); // 10:30 PM Sept 29 in Chicago
  assert.equal(localDate("America/Chicago", lateEvening), "2026-09-29");
  assert.equal(localDate("UTC", lateEvening), "2026-09-30");
});

test("previousDate handles month, year and leap-day boundaries", () => {
  assert.equal(previousDate("2026-10-01"), "2026-09-30");
  assert.equal(previousDate("2027-01-01"), "2026-12-31");
  assert.equal(previousDate("2028-03-01"), "2028-02-29");
});

test("nextOccurrence follows the timezone across daylight saving changes", () => {
  // 9 AM Chicago is 14:00 UTC in summer (CDT) and 15:00 UTC in winter (CST).
  assert.equal(nextOccurrence("0 9 * * *", "America/Chicago", new Date("2026-09-29T20:00:00Z")).toISOString(), "2026-09-30T14:00:00.000Z");
  assert.equal(nextOccurrence("0 9 * * *", "America/Chicago", new Date("2026-11-02T00:00:00Z")).toISOString(), "2026-11-02T15:00:00.000Z");
  // Weekly: Fridays at 6 PM
  assert.equal(nextOccurrence("0 18 * * 5", "America/Chicago", new Date("2026-09-29T00:00:00Z")).toISOString(), "2026-10-02T23:00:00.000Z");
});

test("hourLabel and isValidTimezone", () => {
  assert.deepEqual([0, 9, 12, 23].map(hourLabel), ["12 AM", "9 AM", "12 PM", "11 PM"]);
  assert.ok(isValidTimezone("America/Chicago"));
  assert.ok(!isValidTimezone("Mars/Olympus_Mons"));
});
