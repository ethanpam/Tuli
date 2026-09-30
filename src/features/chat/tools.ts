// Things Tuli can look up or do while chatting, always for the person it's talking to.
// Nothing here is staff-only, so a clever message can't talk Tuli into admin actions.
import type { GuildMember } from "discord.js";
import { getTimezone } from "../../settings.js";
import { friendlyDateTime, localDate, nextOccurrence, previousDate } from "../../time.js";
import {
  claimDaily,
  countWithPoints,
  currentStreak,
  dailyAmount,
  getBalance,
  hasClaimedDaily,
  pointsPosition,
  topByPoints,
} from "../economy/store.js";
import { upcomingEvents } from "../events/store.js";
import { countWithXp, getLevel, levelProgress, listRewards, topByXp, xpPosition } from "../levels/store.js";
import { latestPosted } from "../questions/store.js";
import { randomQuote, randomQuoteByName } from "../quotes/store.js";
import { listItems } from "../shop/store.js";
import type { FunctionDeclaration, Tools } from "./gemini.js";

const DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "check_my_points",
    description: "Look up the points balance, leaderboard rank and daily streak of the person you're talking to.",
  },
  {
    name: "claim_daily_points",
    description: "Claim today's daily points for the person you're talking to. Only do this when they ask you to.",
  },
  {
    name: "check_my_level",
    description: "Look up the level, XP progress and rank of the person you're talking to.",
  },
  {
    name: "leaderboard",
    description: "The top 5 members on the levels or points leaderboard.",
    parameters: {
      type: "object",
      properties: { board: { type: "string", description: "Which leaderboard", enum: ["levels", "points"] } },
      required: ["board"],
    },
  },
  {
    name: "random_quote",
    description: "A random saved quote from the server, optionally from one person.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Part of the person's name, if they want a quote from someone specific" },
      },
    },
  },
  {
    name: "upcoming_events",
    description: "The server's upcoming events with times, places, details and links.",
  },
  {
    name: "shop_items",
    description: "What's in the points shop: names, prices, what you get, and how many are left.",
  },
  {
    name: "todays_question",
    description: "The latest question of the day/week and how to answer it.",
  },
];

export function createTools(member: GuildMember): Tools {
  const guildId = member.guild.id;
  const userId = member.id;
  const timezone = getTimezone(guildId);
  const guild = member.guild;

  const handlers: Record<string, (args: Record<string, unknown>) => Record<string, unknown>> = {
    check_my_points() {
      const today = localDate(timezone);
      const balance = getBalance(guildId, userId);
      return {
        points: balance,
        rank: balance > 0 ? `#${pointsPosition(guildId, userId)} of ${countWithPoints(guildId)}` : "not ranked yet",
        daily_streak_days: currentStreak(guildId, userId, today, previousDate(today)),
        claimed_daily_today: hasClaimedDaily(guildId, userId, today),
      };
    },

    claim_daily_points() {
      const today = localDate(timezone);
      const result = claimDaily(guildId, userId, member.displayName, today, previousDate(today));
      const nextClaim = friendlyDateTime(nextOccurrence("0 0 * * *", timezone), timezone);
      return result.claimed
        ? {
            claimed: true,
            points_earned: result.amount,
            streak_days: result.streak,
            new_balance: result.balance,
            next_claim: nextClaim,
            tomorrow_worth: dailyAmount(result.streak + 1),
          }
        : { claimed: false, reason: "already claimed today", streak_days: result.streak, next_claim: nextClaim };
    },

    check_my_level() {
      const stats = getLevel(guildId, userId);
      const progress = levelProgress(stats.xp);
      const next = listRewards(guildId).find((reward) => reward.level > progress.level);
      return {
        level: progress.level,
        xp_toward_next_level: `${progress.xpIntoLevel} / ${progress.xpForNextLevel}`,
        rank: stats.xp > 0 ? `#${xpPosition(guildId, userId)} of ${countWithXp(guildId)}` : "not ranked yet",
        messages_sent: stats.message_count,
        next_reward: next ? `${guild.roles.cache.get(next.role_id)?.name ?? "a role"} at level ${next.level}` : "none",
      };
    },

    leaderboard({ board }) {
      if (board === "points") {
        return {
          top: topByPoints(guildId, 5, 0).map(
            (row, i) => `${i + 1}. ${row.display_name ?? "someone"}: ${row.points} points`,
          ),
        };
      }
      return {
        top: topByXp(guildId, 5, 0).map((row, i) => `${i + 1}. ${row.display_name ?? "someone"}: level ${row.level}`),
      };
    },

    random_quote({ from }) {
      const quote = typeof from === "string" && from.trim() ? randomQuoteByName(guildId, from) : randomQuote(guildId);
      return quote
        ? { number: quote.number, quote: quote.text, said_by: quote.author_name }
        : { none: "No saved quotes match." };
    },

    upcoming_events() {
      const events = upcomingEvents(guildId, 8);
      if (events.length === 0) return { none: "Nothing's on the calendar." };
      return {
        events: events.map((event) => ({
          title: event.title,
          when: friendlyDateTime(event.starts_at, timezone),
          where: event.location || "not listed",
          details: event.description || undefined,
          link: event.link || undefined,
        })),
      };
    },

    shop_items() {
      const items = listItems(guildId, 25, 0);
      if (items.length === 0) return { none: "The shop is empty right now." };
      return {
        items: items.map((item) => ({
          name: item.name,
          price: item.price,
          you_get: item.role_id
            ? `the ${guild.roles.cache.get(item.role_id)?.name ?? "reward"} role`
            : "a prize staff deliver",
          left: item.stock === null ? "unlimited" : item.stock,
          about: item.description || undefined,
        })),
        how_to_buy: "Use /shop",
      };
    },

    todays_question() {
      const question = latestPosted(guildId);
      if (!question) return { none: "No questions have been posted yet." };
      return {
        question: question.text,
        kind: question.kind,
        choices: question.choices.length ? question.choices : undefined,
        status: question.closed_at ? "closed, results are on the post" : "open",
        how_to_answer:
          question.kind === "open" ? "Reply in the question's thread" : "Click a button on the question post",
        channel: question.channel_id ? `<#${question.channel_id}>` : undefined,
      };
    },
  };

  return {
    declarations: DECLARATIONS,
    async run(name, args) {
      const handler = handlers[name];
      if (!handler) return { error: `There's no tool called ${name}.` };
      return handler(args);
    },
  };
}
