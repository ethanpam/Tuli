import { db } from "../../db.js";

export interface Warning {
  id: number;
  guild_id: string;
  user_id: string;
  moderator_id: string;
  reason: string;
  created_at: number;
}

const insertWarning = db.prepare(`
  INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at)
  VALUES ($guildId, $userId, $moderatorId, $reason, $now) RETURNING *`);
const selectWarnings = db.prepare(
  "SELECT * FROM warnings WHERE guild_id = $guildId AND user_id = $userId ORDER BY id DESC",
);
const deleteWarningRow = db.prepare("DELETE FROM warnings WHERE guild_id = $guildId AND id = $id RETURNING *");

export function addWarning(guildId: string, userId: string, moderatorId: string, reason: string): Warning {
  return insertWarning.get({ guildId, userId, moderatorId, reason, now: Date.now() }) as unknown as Warning;
}

export function listWarnings(guildId: string, userId: string): Warning[] {
  return selectWarnings.all({ guildId, userId }) as unknown as Warning[];
}

/** Deletes a warning, returning it (or undefined if there was no such warning). */
export function deleteWarning(guildId: string, id: number): Warning | undefined {
  return deleteWarningRow.get({ guildId, id }) as Warning | undefined;
}
