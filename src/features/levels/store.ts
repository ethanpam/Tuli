import { db, transaction } from "../../db.js";
import { ensureMember } from "../../members.js";
import { changePoints } from "../economy/store.js";

/** One XP award per minute, so spamming doesn't level anyone up faster. */
export const XP_COOLDOWN_MS = 60_000;
export const XP_PER_MESSAGE = { min: 15, max: 25 };

/** XP needed to go from `level` to the next one (the curve MEE6 uses): 100, 155, 220, 295... */
export function xpToNextLevel(level: number): number {
  return 5 * level ** 2 + 50 * level + 100;
}

/** Total XP needed to reach a level from zero. */
export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpToNextLevel(l);
  return total;
}

export function levelProgress(totalXp: number) {
  let level = 0;
  let remaining = totalXp;
  while (remaining >= xpToNextLevel(level)) {
    remaining -= xpToNextLevel(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpForNextLevel: xpToNextLevel(level) };
}

/** Bonus points for reaching a level: level 5 → 100. */
export function levelUpPoints(level: number): number {
  return level * 20;
}

export interface MemberLevel {
  xp: number;
  level: number;
  message_count: number;
  last_xp_at: number;
}

const selectLevel = db.prepare(
  "SELECT xp, level, message_count, last_xp_at FROM members WHERE guild_id = $guildId AND user_id = $userId",
);
const countMessage = db.prepare("UPDATE members SET message_count = message_count + 1 WHERE guild_id = $guildId AND user_id = $userId");
const updateXp = db.prepare(
  "UPDATE members SET xp = $xp, level = $level, last_xp_at = $now WHERE guild_id = $guildId AND user_id = $userId",
);
const selectTop = db.prepare(`
  SELECT user_id, display_name, xp, level FROM members
  WHERE guild_id = $guildId AND xp > 0 ORDER BY xp DESC, user_id LIMIT $limit OFFSET $offset`);
const selectRankedCount = db.prepare("SELECT COUNT(*) AS count FROM members WHERE guild_id = $guildId AND xp > 0");
const selectPosition = db.prepare(`
  SELECT COUNT(*) + 1 AS position FROM members
  WHERE guild_id = $guildId AND (xp > $xp OR (xp = $xp AND user_id < $userId))`);
const selectAtLevel = db.prepare("SELECT user_id FROM members WHERE guild_id = $guildId AND level >= $level");

const upsertReward = db.prepare(`
  INSERT INTO level_rewards (guild_id, level, role_id) VALUES ($guildId, $level, $roleId)
  ON CONFLICT (guild_id, role_id) DO UPDATE SET level = excluded.level`);
const deleteReward = db.prepare("DELETE FROM level_rewards WHERE guild_id = $guildId AND role_id = $roleId");
const selectRewards = db.prepare("SELECT level, role_id FROM level_rewards WHERE guild_id = $guildId ORDER BY level, role_id");

export function getLevel(guildId: string, userId: string): MemberLevel {
  return (selectLevel.get({ guildId, userId }) as MemberLevel | undefined) ?? { xp: 0, level: 0, message_count: 0, last_xp_at: 0 };
}

export type XpResult =
  | { awarded: false }
  | { awarded: true; gained: number; xp: number; level: number; previousLevel: number; bonusPoints: number };

/**
 * Counts a message and, if the person is off cooldown, gives them XP. Reaching a new
 * level also gives bonus points.
 */
export function awardMessageXp(
  guildId: string,
  userId: string,
  displayName: string,
  now = Date.now(),
  roll = () => XP_PER_MESSAGE.min + Math.floor(Math.random() * (XP_PER_MESSAGE.max - XP_PER_MESSAGE.min + 1)),
): XpResult {
  return transaction(() => {
    ensureMember(guildId, userId, displayName);
    countMessage.run({ guildId, userId });
    const member = getLevel(guildId, userId);
    if (now - member.last_xp_at < XP_COOLDOWN_MS) return { awarded: false };

    const gained = roll();
    const xp = member.xp + gained;
    const { level } = levelProgress(xp);
    updateXp.run({ guildId, userId, xp, level, now });

    let bonusPoints = 0;
    for (let reached = member.level + 1; reached <= level; reached++) bonusPoints += levelUpPoints(reached);
    if (bonusPoints > 0) changePoints({ guildId, userId, amount: bonusPoints, reason: `Reached level ${level}` });
    return { awarded: true, gained, xp, level, previousLevel: member.level, bonusPoints };
  });
}

/** Staff override, e.g. to carry levels over from another bot. Doesn't give level-up points. */
export function setLevel(guildId: string, userId: string, displayName: string, level: number): void {
  transaction(() => {
    ensureMember(guildId, userId, displayName);
    updateXp.run({ guildId, userId, xp: totalXpForLevel(level), level, now: getLevel(guildId, userId).last_xp_at });
  });
}

export function topByXp(guildId: string, limit: number, offset: number) {
  return selectTop.all({ guildId, limit, offset }) as { user_id: string; display_name: string | null; xp: number; level: number }[];
}

export function countWithXp(guildId: string): number {
  return (selectRankedCount.get({ guildId }) as { count: number }).count;
}

export function xpPosition(guildId: string, userId: string): number {
  const { xp } = getLevel(guildId, userId);
  return (selectPosition.get({ guildId, xp, userId }) as { position: number }).position;
}

/** Everyone who has reached at least this level (e.g. to hand out a newly added reward). */
export function membersAtLevel(guildId: string, level: number): string[] {
  return (selectAtLevel.all({ guildId, level }) as { user_id: string }[]).map((row) => row.user_id);
}

export interface LevelReward {
  level: number;
  role_id: string;
}

export function setReward(guildId: string, level: number, roleId: string): void {
  upsertReward.run({ guildId, level, roleId });
}

export function removeReward(guildId: string, roleId: string): boolean {
  return deleteReward.run({ guildId, roleId }).changes > 0;
}

export function listRewards(guildId: string): LevelReward[] {
  return selectRewards.all({ guildId }) as unknown as LevelReward[];
}
