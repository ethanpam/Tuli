import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const path = process.env.DATABASE_PATH ?? join(import.meta.dirname, "..", "data", "tuli.db");
mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path);
db.exec("PRAGMA journal_mode = WAL");

// Each entry runs once, in order, and the database remembers how many have run.
// To change the schema, append a new entry. Never edit one that has already run.
//
// Discord IDs are stored as TEXT: they're too large for JavaScript numbers to hold exactly.
const migrations = [
  `CREATE TABLE quotes (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    number INTEGER NOT NULL,      -- per-server number shown to users
    text TEXT NOT NULL,
    author_id TEXT,               -- the person quoted
    author_name TEXT NOT NULL,    -- their display name when the quote was saved
    added_by_id TEXT NOT NULL,
    channel_id TEXT,              -- set when saved from a message
    message_id TEXT,
    created_at INTEGER NOT NULL,  -- when it was said, in ms since 1970
    UNIQUE (guild_id, number),
    UNIQUE (guild_id, message_id)
  )`,

  // 2: server settings, one row per setting
  `CREATE TABLE guild_settings (
    guild_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,          -- JSON
    PRIMARY KEY (guild_id, key)
  )`,
];

const { user_version: applied } = db.prepare("PRAGMA user_version").get() as { user_version: number };
migrations.slice(applied).forEach((sql, i) => {
  db.exec(`BEGIN; ${sql}; PRAGMA user_version = ${applied + i + 1}; COMMIT;`);
});

let transactionDepth = 0;

/**
 * Runs fn so that either all of its database changes happen or none do, e.g. taking
 * points and recording a purchase. Nested calls join the outer transaction.
 */
export function transaction<T>(fn: () => T): T {
  if (transactionDepth > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  transactionDepth++;
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    transactionDepth--;
  }
}
