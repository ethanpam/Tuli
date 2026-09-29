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
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
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
