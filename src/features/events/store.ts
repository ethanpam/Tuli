import { db } from "../../db.js";

export interface Event {
  id: number;
  guild_id: string;
  title: string;
  starts_at: number;
  location: string;
  description: string;
  link: string;
  created_by: string;
  created_at: number;
}

export type NewEvent = Pick<Event, "title" | "starts_at" | "location" | "description" | "link" | "created_by">;

const insertEvent = db.prepare(`
  INSERT INTO events (guild_id, title, starts_at, location, description, link, created_by, created_at)
  VALUES ($guildId, $title, $starts_at, $location, $description, $link, $created_by, $now) RETURNING *`);
const selectUpcoming = db.prepare(
  "SELECT * FROM events WHERE guild_id = $guildId AND starts_at >= $from ORDER BY starts_at LIMIT $limit",
);
const selectEvent = db.prepare("SELECT * FROM events WHERE guild_id = $guildId AND id = $id");
const deleteEvent = db.prepare("DELETE FROM events WHERE guild_id = $guildId AND id = $id");
const searchEvents = db.prepare(`
  SELECT * FROM events WHERE guild_id = $guildId AND starts_at >= $from AND title LIKE $pattern ESCAPE '\\'
  ORDER BY starts_at LIMIT 25`);

/** How long an event stays "upcoming" after it starts, so a GBM in progress still shows. */
export const STILL_HAPPENING_MS = 3 * 60 * 60 * 1000;

export function addEvent(guildId: string, event: NewEvent): Event {
  return insertEvent.get({ guildId, ...event, now: Date.now() }) as unknown as Event;
}

/** Events that haven't finished yet (started less than 3 hours ago, or later), soonest first. */
export function upcomingEvents(guildId: string, limit = 10, now = Date.now()): Event[] {
  return selectUpcoming.all({ guildId, from: now - STILL_HAPPENING_MS, limit }) as unknown as Event[];
}

export function getEvent(guildId: string, id: number): Event | undefined {
  return selectEvent.get({ guildId, id }) as Event | undefined;
}

export function removeEvent(guildId: string, id: number): void {
  deleteEvent.run({ guildId, id });
}

export function findUpcomingEvents(guildId: string, query: string, now = Date.now()): Event[] {
  const pattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  return searchEvents.all({ guildId, from: now - STILL_HAPPENING_MS, pattern }) as unknown as Event[];
}
