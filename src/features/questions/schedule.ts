import type { QuestionSchedule } from "../../settings.js";
import { hourLabel, nextOccurrence, WEEKDAYS } from "../../time.js";

export function cronFor(schedule: QuestionSchedule): string {
  return schedule.frequency === "daily" ? `0 ${schedule.hour} * * *` : `0 ${schedule.hour} * * ${schedule.weekday}`;
}

/** "every day at 9 AM" or "every Monday at 6 PM" */
export function describeSchedule(schedule: QuestionSchedule): string {
  const when = schedule.frequency === "daily" ? "every day" : `every ${WEEKDAYS[schedule.weekday]}`;
  return `${when} at ${hourLabel(schedule.hour)}`;
}

export function questionLabel(schedule: QuestionSchedule | undefined): string {
  return schedule?.frequency === "weekly" ? "Question of the Week" : "Question of the Day";
}

/**
 * Whether a post is due: a scheduled time has passed since the scheduler last ran.
 * If Tuli was offline through one or more posting times, this is true once, so it
 * catches up with a single post instead of several.
 */
export function isDue(schedule: QuestionSchedule, timezone: string, lastRunAt: number, now: number): boolean {
  return nextOccurrence(cronFor(schedule), timezone, new Date(lastRunAt)).getTime() <= now;
}

export function nextPostAt(schedule: QuestionSchedule, timezone: string, now = Date.now()): Date {
  return nextOccurrence(cronFor(schedule), timezone, new Date(now));
}
