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

  // 3: points. Every change is recorded in point_transactions so balances can be audited.
  `CREATE TABLE members (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT,            -- last known name, for leaderboards
    points INTEGER NOT NULL DEFAULT 0,
    daily_streak INTEGER NOT NULL DEFAULT 0,
    last_daily TEXT,              -- YYYY-MM-DD in the server's timezone
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE point_transactions (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,      -- positive = earned, negative = spent
    reason TEXT NOT NULL,
    actor_id TEXT,                -- who caused it, e.g. the admin who gave points
    created_at INTEGER NOT NULL
  );
  CREATE INDEX point_transactions_by_member ON point_transactions (guild_id, user_id, id)`,

  // 4: levels. XP comes from chatting; reward roles are handed out at certain levels.
  `ALTER TABLE members ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE members ADD COLUMN level INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE members ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE members ADD COLUMN last_xp_at INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX members_by_xp ON members (guild_id, xp);
  CREATE TABLE level_rewards (
    guild_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  )`,

  // 5: the shop. Orders keep the item's name and price from when it was bought.
  `CREATE TABLE shop_items (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL,
    role_id TEXT,                 -- given automatically when bought
    stock INTEGER,                -- NULL = unlimited
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX shop_items_by_name ON shop_items (guild_id, name COLLATE NOCASE);
  CREATE TABLE shop_orders (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    item_id INTEGER,
    item_name TEXT NOT NULL,
    price INTEGER NOT NULL,
    status TEXT NOT NULL,         -- 'pending' (staff will deliver), 'delivered' or 'refunded'
    handled_by TEXT,
    created_at INTEGER NOT NULL,
    handled_at INTEGER
  );
  CREATE INDEX shop_orders_by_member ON shop_orders (guild_id, user_id, id);
  CREATE INDEX shop_orders_by_status ON shop_orders (guild_id, status, id)`,

  // 6: daily/weekly questions, and who has answered each one (for answer points).
  `CREATE TABLE questions (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL,         -- 'suggested', 'queued' or 'posted'
    added_by_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    number INTEGER,               -- #1, #2... per server, set when posted
    posted_at INTEGER,
    channel_id TEXT,
    message_id TEXT,
    thread_id TEXT
  );
  CREATE INDEX questions_by_status ON questions (guild_id, status, id);
  CREATE UNIQUE INDEX questions_by_thread ON questions (thread_id);
  CREATE TABLE question_answers (
    question_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (question_id, user_id)
  )`,

  // 7: moderator warnings
  `CREATE TABLE warnings (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX warnings_by_member ON warnings (guild_id, user_id, id)`,

  // 8: RSS/Atom feeds, and which of their posts Tuli has already shared
  `CREATE TABLE feeds (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '',  -- comma-separated; empty = post everything
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    last_error TEXT,
    UNIQUE (guild_id, url, channel_id)
  );
  CREATE TABLE feed_items (
    feed_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,             -- the post's guid, id or link
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (feed_id, item_key)
  )`,

  // 9: multiple-choice and true/false questions
  `ALTER TABLE questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'open';  -- 'open', 'choice' or 'truefalse'
  ALTER TABLE questions ADD COLUMN choices TEXT;                      -- JSON list of answers to pick from
  ALTER TABLE questions ADD COLUMN answer INTEGER;                    -- index of the right answer; NULL = a poll
  ALTER TABLE questions ADD COLUMN closed_at INTEGER;                 -- when the results were revealed
  ALTER TABLE question_answers ADD COLUMN choice INTEGER`, // which button they picked

  // 10: upcoming events (GBMs, socials...), which Tuli can also tell people about
  `CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    title TEXT NOT NULL,
    starts_at INTEGER NOT NULL,         -- ms since 1970
    location TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',      -- e.g. an RSVP form
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX events_by_start ON events (guild_id, starts_at)`,
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
