import {
  escapeMarkdown,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  time,
  TimestampStyles,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { getTimezone } from "../../settings.js";
import { sendStaffLog } from "../../staff-log.js";
import { localDate, nextOccurrence, previousDate } from "../../time.js";
import type { AdminGroup, Feature, SlashCommand } from "../../types.js";
import { Colors, commandMention, embed, formatNumber, formatPoints, notice, plural, replyNotice } from "../../ui.js";
import type { Board } from "../leaderboard.js";
import {
  changePoints,
  claimDaily,
  countWithPoints,
  currentStreak,
  dailyAmount,
  getBalance,
  hasClaimedDaily,
  NotEnoughPointsError,
  pointsPosition,
  recentTransactions,
  topByPoints,
  transferPoints,
} from "./store.js";

/** Shown under balances so people know how to earn more. */
export const EARN_HINT = "Earn points with /points daily, by leveling up, and by answering questions";

const HISTORY_LENGTH = 15;
const MAX_AMOUNT = 1_000_000;

/** Today and yesterday in the server's timezone, plus when "today" ends. */
function dailyWindow(guildId: string) {
  const timezone = getTimezone(guildId);
  const today = localDate(timezone);
  return { today, yesterday: previousDate(today), resetsAt: nextOccurrence("0 0 * * *", timezone) };
}

/** Rejects bots, which can't hold points. Returns true if the target is fine. */
async function checkNotBot(
  interaction: ChatInputCommandInteraction<"cached">,
  target: { bot: boolean },
): Promise<boolean> {
  if (!target.bot) return true;
  await replyNotice(interaction, "error", "Bots don't have points.");
  return false;
}

function signed(amount: number): string {
  return amount > 0 ? `+${formatNumber(amount)}` : `−${formatNumber(-amount)}`;
}

const pointsCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("points")
    .setDescription("Check, earn and send points")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("balance")
        .setDescription("See how many points you (or someone else) have")
        .addUserOption((o) => o.setName("member").setDescription("Whose balance to check (default: yours)")),
    )
    .addSubcommand((sub) =>
      sub.setName("daily").setDescription("Claim your daily points. Come back every day to build a streak"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("pay")
        .setDescription("Send some of your points to someone")
        .addUserOption((o) => o.setName("member").setDescription("Who to send points to").setRequired(true))
        .addIntegerOption((o) =>
          o
            .setName("amount")
            .setDescription("How many points")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(MAX_AMOUNT),
        )
        .addStringOption((o) => o.setName("note").setDescription("What it's for").setMaxLength(100)),
    )
    .addSubcommand((sub) => sub.setName("history").setDescription("See your recent points activity")),

  async execute(interaction) {
    const { guildId } = interaction;

    switch (interaction.options.getSubcommand()) {
      case "balance": {
        const user = interaction.options.getUser("member") ?? interaction.user;
        if (!(await checkNotBot(interaction, user))) return;
        const member: GuildMember | null =
          interaction.options.getMember("member") ?? (user.id === interaction.user.id ? interaction.member : null);
        const name = member?.displayName ?? user.displayName;
        const balance = getBalance(guildId, user.id);
        const { today, yesterday, resetsAt } = dailyWindow(guildId);
        const streak = currentStreak(guildId, user.id, today, yesterday);

        const card = embed(Colors.gold)
          .setAuthor({ name, iconURL: (member ?? user).displayAvatarURL() })
          .setDescription(`## ${formatPoints(balance)}`)
          .addFields(
            {
              name: "Rank",
              value:
                balance > 0
                  ? `#${pointsPosition(guildId, user.id)} of ${formatNumber(countWithPoints(guildId))}`
                  : "Unranked",
              inline: true,
            },
            { name: "Daily streak", value: streak ? `🔥 ${plural(streak, "day")}` : "None yet", inline: true },
          )
          .setFooter({ text: EARN_HINT });
        if (user.id === interaction.user.id) {
          card.addFields({
            name: "Daily reward",
            value: hasClaimedDaily(guildId, user.id, today)
              ? `Claimed · next one ${time(resetsAt, TimestampStyles.RelativeTime)}`
              : `Ready! ${commandMention(interaction.client, "points daily")}`,
            inline: true,
          });
        }
        await interaction.reply({ embeds: [card] });
        return;
      }

      case "daily": {
        const { today, yesterday, resetsAt } = dailyWindow(guildId);
        const result = claimDaily(guildId, interaction.user.id, interaction.member.displayName, today, yesterday);
        const comeBack = time(resetsAt, TimestampStyles.RelativeTime);
        if (!result.claimed) {
          await replyNotice(
            interaction,
            "info",
            `You've already claimed today's points. Come back ${comeBack} for ${formatPoints(dailyAmount(result.streak + 1))}.`,
          );
          return;
        }
        const streakLine =
          result.streak > 1
            ? `🔥 **${result.streak}-day streak!**`
            : "🔥 Streak started. Come back tomorrow to keep it going.";
        const reward = embed(Colors.gold)
          .setTitle("🎁 Daily reward")
          .setDescription(
            `**${escapeMarkdown(interaction.member.displayName)}** claimed **${formatPoints(result.amount)}**\n${streakLine}\n\n` +
              `Next claim ${comeBack} for **${formatPoints(dailyAmount(result.streak + 1))}**`,
          )
          .setFooter({ text: `Balance: ${formatNumber(result.balance)} points` });
        await interaction.reply({ embeds: [reward] });
        return;
      }

      case "pay": {
        const recipient = interaction.options.getUser("member", true);
        const amount = interaction.options.getInteger("amount", true);
        const note = interaction.options.getString("note") ?? undefined;
        if (!(await checkNotBot(interaction, recipient))) return;
        if (recipient.id === interaction.user.id) {
          await replyNotice(interaction, "error", "You can't pay yourself.");
          return;
        }
        const recipientName = interaction.options.getMember("member")?.displayName ?? recipient.displayName;
        try {
          const { fromBalance } = transferPoints(
            guildId,
            { id: interaction.user.id, name: interaction.member.displayName },
            { id: recipient.id, name: recipientName },
            amount,
            note,
          );
          const receipt = embed(Colors.success)
            .setDescription(
              `💸 **${escapeMarkdown(interaction.member.displayName)}** sent **${formatPoints(amount)}** to **${escapeMarkdown(recipientName)}**` +
                (note ? `\n> ${escapeMarkdown(note)}` : ""),
            )
            .setFooter({ text: `${interaction.member.displayName} has ${formatNumber(fromBalance)} points left` });
          await interaction.reply({
            content: `${recipient}`,
            embeds: [receipt],
            allowedMentions: { users: [recipient.id] },
          });
        } catch (error) {
          if (!(error instanceof NotEnoughPointsError)) throw error;
          await replyNotice(interaction, "error", `You only have ${formatPoints(error.balance)}.`);
        }
        return;
      }

      case "history": {
        const transactions = recentTransactions(guildId, interaction.user.id, HISTORY_LENGTH);
        const lines = transactions.map(
          (entry) =>
            `\`${signed(entry.amount).padStart(7)}\` ${escapeMarkdown(entry.reason)} · ${time(Math.floor(entry.created_at / 1000), TimestampStyles.RelativeTime)}`,
        );
        const history = embed(Colors.gold)
          .setTitle("🧾 Your points history")
          .setDescription(
            `Balance: **${formatPoints(getBalance(guildId, interaction.user.id))}**\n\n` +
              (lines.join("\n") || "No points activity yet."),
          )
          .setFooter({ text: `Your last ${HISTORY_LENGTH} changes · ${EARN_HINT}` });
        await interaction.reply({ embeds: [history], flags: MessageFlags.Ephemeral });
        return;
      }
    }
  },
};

const pointsAdmin: AdminGroup = {
  name: "points",
  description: "Give or take points",
  build: (group) =>
    group
      .addSubcommand((sub) =>
        sub
          .setName("give")
          .setDescription("Give someone points, e.g. for coming to a meeting")
          .addUserOption((o) => o.setName("member").setDescription("Who gets the points").setRequired(true))
          .addIntegerOption((o) =>
            o
              .setName("amount")
              .setDescription("How many points")
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(MAX_AMOUNT),
          )
          .addStringOption((o) =>
            o.setName("reason").setDescription("Shown to them in their history").setRequired(true).setMaxLength(100),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("take")
          .setDescription("Take points away from someone")
          .addUserOption((o) => o.setName("member").setDescription("Who loses the points").setRequired(true))
          .addIntegerOption((o) =>
            o
              .setName("amount")
              .setDescription("How many points")
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(MAX_AMOUNT),
          )
          .addStringOption((o) =>
            o.setName("reason").setDescription("Shown to them in their history").setRequired(true).setMaxLength(100),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("history")
          .setDescription("See someone's recent points activity")
          .addUserOption((o) => o.setName("member").setDescription("Whose history to see").setRequired(true)),
      ),

  async execute(interaction) {
    const { guildId } = interaction;
    const user = interaction.options.getUser("member", true);
    if (!(await checkNotBot(interaction, user))) return;
    const name = interaction.options.getMember("member")?.displayName ?? user.displayName;
    const reason = interaction.options.getString("reason") ?? "";
    const staffName = interaction.member.displayName;

    switch (interaction.options.getSubcommand()) {
      case "give": {
        const amount = interaction.options.getInteger("amount", true);
        const balance = changePoints({
          guildId,
          userId: user.id,
          amount,
          reason,
          actorId: interaction.user.id,
          displayName: name,
        });
        const announcement = embed(Colors.gold).setDescription(
          `🎉 **${escapeMarkdown(name)}** received **${formatPoints(amount)}**\n> ${escapeMarkdown(reason)}`,
        );
        await interaction.reply({ content: `${user}`, embeds: [announcement], allowedMentions: { users: [user.id] } });
        await sendStaffLog(interaction.guild, {
          embeds: [
            notice(
              "info",
              `**${escapeMarkdown(staffName)}** gave ${user} ${formatPoints(amount)} (now ${formatNumber(balance)}): ${escapeMarkdown(reason)}`,
            ),
          ],
        });
        return;
      }

      case "take": {
        // Take what they have if it's less than asked, rather than failing.
        const amount = Math.min(interaction.options.getInteger("amount", true), getBalance(guildId, user.id));
        if (amount === 0) {
          await replyNotice(interaction, "info", `${escapeMarkdown(name)} has no points to take.`);
          return;
        }
        const balance = changePoints({
          guildId,
          userId: user.id,
          amount: -amount,
          reason,
          actorId: interaction.user.id,
          displayName: name,
        });
        await replyNotice(
          interaction,
          "success",
          `Took ${formatPoints(amount)} from ${user}. They now have ${formatPoints(balance)}.`,
        );
        await sendStaffLog(interaction.guild, {
          embeds: [
            notice(
              "warning",
              `**${escapeMarkdown(staffName)}** took ${formatPoints(amount)} from ${user} (now ${formatNumber(balance)}): ${escapeMarkdown(reason)}`,
            ),
          ],
        });
        return;
      }

      case "history": {
        const lines = recentTransactions(guildId, user.id, HISTORY_LENGTH).map((entry) => {
          const by = entry.actor_id && entry.actor_id !== user.id ? ` · by <@${entry.actor_id}>` : "";
          return `\`${signed(entry.amount).padStart(7)}\` ${escapeMarkdown(entry.reason)}${by} · ${time(Math.floor(entry.created_at / 1000), TimestampStyles.RelativeTime)}`;
        });
        const history = embed(Colors.gold)
          .setTitle(`🧾 ${name}'s points history`)
          .setDescription(
            `Balance: **${formatPoints(getBalance(guildId, user.id))}**\n\n${lines.join("\n") || "No points activity yet."}`,
          );
        await interaction.reply({ embeds: [history], flags: MessageFlags.Ephemeral });
        return;
      }
    }
  },
};

export const pointsBoard: Board = {
  id: "points",
  label: "Points",
  emoji: "🪙",
  count: countWithPoints,
  rows: (guildId, limit, offset) =>
    topByPoints(guildId, limit, offset).map((row) => ({
      userId: row.user_id,
      name: row.display_name,
      value: formatPoints(row.points),
    })),
};

export const economyFeature: Feature = {
  name: "Points",
  slashCommands: [pointsCommand],
  admin: pointsAdmin,
};
