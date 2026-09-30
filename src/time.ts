import { Cron } from "croner";

export const TIMEZONES = Intl.supportedValuesOf("timeZone");

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Today's date in a timezone as YYYY-MM-DD, e.g. for "once per day" limits. */
export function localDate(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** previousDate("2026-03-01") → "2026-02-28". Pure calendar math, so DST can't skew it. */
export function previousDate(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/** The current time in a timezone, e.g. "3:42 PM". */
export function localTime(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(at);
}

/**
 * The next time a cron pattern fires in a timezone, after a given moment.
 * Patterns are "minute hour day-of-month month day-of-week", e.g. "0 9 * * 1" = Mondays at 9:00.
 */
export function nextOccurrence(pattern: string, timezone: string, after = new Date()): Date {
  const cron = new Cron(pattern, { timezone, paused: true });
  try {
    const next = cron.nextRun(after);
    if (!next) throw new Error(`Cron pattern "${pattern}" never runs`);
    return next;
  } finally {
    cron.stop();
  }
}

/** hourLabel(0) → "12 AM", hourLabel(13) → "1 PM" */
export function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12} ${suffix}`;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** How far ahead of UTC a timezone is at a given moment, in ms (e.g. -5 hours for Chicago in summer). */
function offsetAt(ms: number, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, Number(part.value)]),
  );
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The moment a wall-clock time happens in a timezone, e.g. 6:30 PM on Oct 15 in Chicago. */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetAt(wall, timezone);
  // Near a daylight saving change the offset at the first guess can differ, so check once more.
  return new Date(wall - offsetAt(first, timezone));
}

/**
 * Reads a date like "10/15", "10/15/2026" or "2026-10-15" and a time like "6:30 PM", "6pm"
 * or "18:30" in a timezone. A date without a year means the next time that date comes around.
 */
export function parseDateTime(
  dateText: string,
  timeText: string,
  timezone: string,
  now = new Date(),
): { date: Date } | { problem: string } {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateText.trim());
  const us = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(dateText.trim());
  const time = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(timeText.trim().replace(/\./g, ""));
  if (!iso && !us) return { problem: `I couldn't read the date "${dateText}". Try 10/15 or 2026-10-15.` };
  if (!time) return { problem: `I couldn't read the time "${timeText}". Try 6:30 PM or 18:30.` };

  const [, hourText = "0", minuteText = "0", meridiem] = time;
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (meridiem) {
    if (hour < 1 || hour > 12) return { problem: `"${timeText}" isn't a real time.` };
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return { problem: `"${timeText}" isn't a real time.` };

  const today = localDate(timezone, now);
  const thisYear = Number(today.slice(0, 4));
  let year = iso ? Number(iso[1]) : us?.[3] ? Number(us[3].length === 2 ? `20${us[3]}` : us[3]) : thisYear;
  const month = Number(iso ? iso[2] : us![1]);
  const day = Number(iso ? iso[3] : us![2]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
    return { problem: `"${dateText}" isn't a real date.` };
  // "10/15" in November means next October.
  if (!iso && !us?.[3] && `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` < today) year++;
  return { date: zonedTime(year, month, day, hour, minute, timezone) };
}

/** "Thu, Oct 15 at 6:30 PM", in a timezone. */
export function friendlyDateTime(at: Date | number, timezone: string): string {
  const date = new Date(at);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
  return `${day} at ${localTime(timezone, date)}`;
}
