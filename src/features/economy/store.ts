import { db, transaction } from "../../db.js";
import { ensureMember } from "../../members.js";

export const DAILY_BASE = 50;
export const DAILY_STREAK_BONUS = 10;
export const DAILY_MAX_BONUS = 50;

/** Day 1: 50, day 2: 60 ... day 6 and after: 100. */
export function dailyAmount(streak: number): number {
  return DAILY_BASE + Math.min((streak - 1) * DAILY_STREAK_BONUS, DAILY_MAX_BONUS);
}

export class NotEnoughPointsError extends Error {
  constructor(readonly balance: number) {
    super(`Only has ${balance} points`);
  }
}

export interface Transaction {
  id: number;
  amount: number;
  reason: string;
  actor_id: string | null;
  created_at: number;
}

interface MemberPoints {
  points: number;
  daily_streak: number;
  last_daily: string | null;
}

const selectPoints = db.prepare(
  "SELECT points, daily_streak, last_daily FROM members WHERE guild_id = $guildId AND user_id = $userId",
);
const updatePoints = db.prepare(
  "UPDATE members SET points = points + $amount WHERE guild_id = $guildId AND user_id = $userId",
);
const insertTransaction = db.prepare(`
  INSERT INTO point_transactions (guild_id, user_id, amount, reason, actor_id, created_at)
  VALUES ($guildId, $userId, $amount, $reason, $actorId, $now)`);
const updateDaily = db.prepare(
  "UPDATE members SET daily_streak = $streak, last_daily = $today WHERE guild_id = $guildId AND user_id = $userId",
);
const selectRecent = db.prepare(`
  SELECT id, amount, reason, actor_id, created_at FROM point_transactions
  WHERE guild_id = $guildId AND user_id = $userId ORDER BY id DESC LIMIT $limit`);
const selectTop = db.prepare(`
  SELECT user_id, display_name, points FROM members
  WHERE guild_id = $guildId AND points > 0 ORDER BY points DESC, user_id LIMIT $limit OFFSET $offset`);
const selectRankedCount = db.prepare("SELECT COUNT(*) AS count FROM members WHERE guild_id = $guildId AND points > 0");
const selectPosition = db.prepare(`
  SELECT COUNT(*) + 1 AS position FROM members
  WHERE guild_id = $guildId AND (points > $points OR (points = $points AND user_id < $userId))`);

function memberPoints(guildId: string, userId: string): MemberPoints {
  return (
    (selectPoints.get({ guildId, userId }) as MemberPoints | undefined) ?? {
      points: 0,
      daily_streak: 0,
      last_daily: null,
    }
  );
}

export function getBalance(guildId: string, userId: string): number {
  return memberPoints(guildId, userId).points;
}

export interface PointChange {
  guildId: string;
  userId: string;
  /** Positive to give, negative to take. */
  amount: number;
  /** Shown in /points history, e.g. "Daily reward". */
  reason: string;
  actorId?: string;
  displayName?: string | null;
}

/** Adds or removes points and records why. Throws NotEnoughPointsError instead of going below zero. */
export function changePoints(change: PointChange): number {
  return transaction(() => {
    ensureMember(change.guildId, change.userId, change.displayName);
    const balance = getBalance(change.guildId, change.userId);
    if (balance + change.amount < 0) throw new NotEnoughPointsError(balance);
    updatePoints.run({ guildId: change.guildId, userId: change.userId, amount: change.amount });
    insertTransaction.run({
      guildId: change.guildId,
      userId: change.userId,
      amount: change.amount,
      reason: change.reason,
      actorId: change.actorId ?? null,
      now: Date.now(),
    });
    return balance + change.amount;
  });
}

export interface Party {
  id: string;
  name: string;
}

/** Moves points from one person to another. Both balances change or neither does. */
export function transferPoints(guildId: string, from: Party, to: Party, amount: number, note?: string) {
  const suffix = note ? `: ${note}` : "";
  return transaction(() => ({
    fromBalance: changePoints({
      guildId,
      userId: from.id,
      amount: -amount,
      reason: `Sent to ${to.name}${suffix}`,
      actorId: from.id,
      displayName: from.name,
    }),
    toBalance: changePoints({
      guildId,
      userId: to.id,
      amount,
      reason: `From ${from.name}${suffix}`,
      actorId: from.id,
      displayName: to.name,
    }),
  }));
}

export type DailyResult =
  { claimed: true; amount: number; streak: number; balance: number } | { claimed: false; streak: number };

/**
 * Claims today's reward. Claiming on consecutive days (in the server's timezone) builds a
 * streak that raises the reward; missing a day starts over.
 */
export function claimDaily(
  guildId: string,
  userId: string,
  displayName: string,
  today: string,
  yesterday: string,
): DailyResult {
  return transaction(() => {
    ensureMember(guildId, userId, displayName);
    const member = memberPoints(guildId, userId);
    if (member.last_daily === today) return { claimed: false, streak: member.daily_streak };

    const streak = member.last_daily === yesterday ? member.daily_streak + 1 : 1;
    const amount = dailyAmount(streak);
    updateDaily.run({ guildId, userId, streak, today });
    const balance = changePoints({
      guildId,
      userId,
      amount,
      reason: streak > 1 ? `Daily reward (${streak}-day streak)` : "Daily reward",
    });
    return { claimed: true, amount, streak, balance };
  });
}

/** The streak someone would continue if they claimed today (0 if it has lapsed). */
export function currentStreak(guildId: string, userId: string, today: string, yesterday: string): number {
  const { daily_streak, last_daily } = memberPoints(guildId, userId);
  return last_daily === today || last_daily === yesterday ? daily_streak : 0;
}

export function hasClaimedDaily(guildId: string, userId: string, today: string): boolean {
  return memberPoints(guildId, userId).last_daily === today;
}

export function recentTransactions(guildId: string, userId: string, limit: number): Transaction[] {
  return selectRecent.all({ guildId, userId, limit }) as unknown as Transaction[];
}

export function topByPoints(guildId: string, limit: number, offset: number) {
  return selectTop.all({ guildId, limit, offset }) as {
    user_id: string;
    display_name: string | null;
    points: number;
  }[];
}

export function countWithPoints(guildId: string): number {
  return (selectRankedCount.get({ guildId }) as { count: number }).count;
}

/** 1-based position on the points leaderboard (ties broken by user ID so it's stable). */
export function pointsPosition(guildId: string, userId: string): number {
  const points = getBalance(guildId, userId);
  return (selectPosition.get({ guildId, points, userId }) as { position: number }).position;
}
