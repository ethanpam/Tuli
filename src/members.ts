import { db } from "./db.js";

// One row per person per server, shared by points and levels.

const upsertMember = db.prepare(`
  INSERT INTO members (guild_id, user_id, display_name) VALUES ($guildId, $userId, $displayName)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET display_name = COALESCE(excluded.display_name, members.display_name)`);

/** Makes sure someone has a row, and remembers their current name for leaderboards. */
export function ensureMember(guildId: string, userId: string, displayName?: string | null): void {
  upsertMember.run({ guildId, userId, displayName: displayName ?? null });
}
