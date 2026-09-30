import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hourLabel,
  isValidTimezone,
  localDate,
  nextOccurrence,
  parseDateTime,
  previousDate,
  zonedTime,
} from "../src/time.js";

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
  assert.equal(
    nextOccurrence("0 9 * * *", "America/Chicago", new Date("2026-09-29T20:00:00Z")).toISOString(),
    "2026-09-30T14:00:00.000Z",
  );
  assert.equal(
    nextOccurrence("0 9 * * *", "America/Chicago", new Date("2026-11-02T00:00:00Z")).toISOString(),
    "2026-11-02T15:00:00.000Z",
  );
  // Weekly: Fridays at 6 PM
  assert.equal(
    nextOccurrence("0 18 * * 5", "America/Chicago", new Date("2026-09-29T00:00:00Z")).toISOString(),
    "2026-10-02T23:00:00.000Z",
  );
});

test("hourLabel and isValidTimezone", () => {
  assert.deepEqual([0, 9, 12, 23].map(hourLabel), ["12 AM", "9 AM", "12 PM", "11 PM"]);
  assert.ok(isValidTimezone("America/Chicago"));
  assert.ok(!isValidTimezone("Mars/Olympus_Mons"));
});

test("zonedTime turns a wall-clock time into the right moment, across DST", () => {
  // 6:30 PM in Chicago is 23:30 UTC in October (CDT) and 00:30 UTC the next day in December (CST).
  assert.equal(zonedTime(2026, 10, 15, 18, 30, "America/Chicago").toISOString(), "2026-10-15T23:30:00.000Z");
  assert.equal(zonedTime(2026, 12, 3, 18, 30, "America/Chicago").toISOString(), "2026-12-04T00:30:00.000Z");
  assert.equal(zonedTime(2026, 10, 15, 9, 0, "Asia/Tokyo").toISOString(), "2026-10-15T00:00:00.000Z");
});

test("parseDateTime reads the ways people write dates and times", () => {
  const now = new Date("2026-10-06T14:05:00Z");
  const iso = (date: string, time: string) => {
    const result = parseDateTime(date, time, "America/Chicago", now);
    return "date" in result ? result.date.toISOString() : result.problem;
  };
  assert.equal(iso("10/15", "6:30 PM"), "2026-10-15T23:30:00.000Z");
  assert.equal(iso("2026-10-15", "18:30"), "2026-10-15T23:30:00.000Z");
  assert.equal(iso("10/15/26", "6:30pm"), "2026-10-15T23:30:00.000Z");
  assert.equal(iso("10/15", "6pm"), "2026-10-15T23:00:00.000Z");
  assert.equal(iso("10/15", "12 am"), "2026-10-15T05:00:00.000Z");
  assert.equal(iso("1/20", "7 PM"), "2027-01-21T01:00:00.000Z", "a date that already passed this year means next year");
  assert.match(iso("2/30", "6 PM"), /isn't a real date/);
  assert.match(iso("tomorrow", "6 PM"), /couldn't read the date/);
  assert.match(iso("10/15", "25:00"), /isn't a real time/);
  assert.match(iso("10/15", "13 PM"), /isn't a real time/);
});
