import { db, transaction } from "../../db.js";
import { FeedError } from "./parse.js";

export interface Feed {
  id: number;
  guild_id: string;
  channel_id: string;
  url: string;
  title: string;
  keywords: string;
  created_at: number;
  last_checked_at: number | null;
  last_error: string | null;
}

const SEEN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const insertFeed = db.prepare(`
  INSERT INTO feeds (guild_id, channel_id, url, title, keywords, created_at)
  VALUES ($guildId, $channelId, $url, $title, $keywords, $now) RETURNING *`);
const selectFeed = db.prepare("SELECT * FROM feeds WHERE guild_id = $guildId AND id = $id");
const selectGuildFeeds = db.prepare("SELECT * FROM feeds WHERE guild_id = $guildId ORDER BY id");
const selectAllFeeds = db.prepare("SELECT * FROM feeds ORDER BY id");
const deleteFeed = db.prepare("DELETE FROM feeds WHERE guild_id = $guildId AND id = $id");
const deleteFeedItems = db.prepare("DELETE FROM feed_items WHERE feed_id = $feedId");
const updateCheck = db.prepare("UPDATE feeds SET last_checked_at = $now, last_error = $error WHERE id = $id");
const insertSeen = db.prepare("INSERT OR IGNORE INTO feed_items (feed_id, item_key, seen_at) VALUES ($feedId, $key, $now)");
const selectSeen = db.prepare("SELECT 1 FROM feed_items WHERE feed_id = $feedId AND item_key = $key");
const pruneSeenRows = db.prepare("DELETE FROM feed_items WHERE feed_id = $feedId AND seen_at < $before");

export function addFeed(guildId: string, fields: { channelId: string; url: string; title: string; keywords: string }): Feed {
  try {
    return insertFeed.get({ guildId, ...fields, now: Date.now() }) as unknown as Feed;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new FeedError("That feed is already set up for that channel.");
    throw error;
  }
}

export function getFeed(guildId: string, id: number): Feed | undefined {
  return selectFeed.get({ guildId, id }) as Feed | undefined;
}

export function listFeeds(guildId: string): Feed[] {
  return selectGuildFeeds.all({ guildId }) as unknown as Feed[];
}

export function allFeeds(): Feed[] {
  return selectAllFeeds.all() as unknown as Feed[];
}

export function removeFeed(guildId: string, id: number): void {
  transaction(() => {
    deleteFeed.run({ guildId, id });
    deleteFeedItems.run({ feedId: id });
  });
}

export function recordCheck(id: number, error: string | null): void {
  updateCheck.run({ id, error, now: Date.now() });
}

/** Of these post keys, the ones Tuli hasn't shared (or deliberately skipped) yet. */
export function unseen(feedId: number, keys: string[]): string[] {
  return keys.filter((key) => !selectSeen.get({ feedId, key }));
}

/** Remembers posts so they're never shared twice, and forgets ones from long ago. */
export function markSeen(feedId: number, keys: string[], now = Date.now()): void {
  transaction(() => {
    for (const key of keys) insertSeen.run({ feedId, key, now });
    pruneSeenRows.run({ feedId, before: now - SEEN_RETENTION_MS });
  });
}

export function keywordList(feed: Pick<Feed, "keywords">): string[] {
  return feed.keywords
    .split(",")
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether a post matches a feed's keywords (feeds without keywords match everything). */
export function matchesKeywords(feed: Pick<Feed, "keywords">, title: string, summary: string): boolean {
  const keywords = keywordList(feed);
  if (keywords.length === 0) return true;
  const haystack = `${title}\n${summary}`.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}
