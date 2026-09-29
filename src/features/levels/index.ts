import {
  ChannelType,
  escapeMarkdown,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type Message,
} from "discord.js";
import { giveRole, rewardRoleProblem } from "../../roles.js";
import { getSetting, setSetting } from "../../settings.js";
import { sendStaffLog } from "../../staff-log.js";
import type { AdminGroup, Feature, SlashCommand } from "../../types.js";
import { Colors, embed, formatNumber, formatPoints, notice, plural, progressBar, replyNotice } from "../../ui.js";
import type { Board } from "../leaderboard.js";
import {
  awardMessageXp,
  countWithXp,
  getLevel,
  levelProgress,
  listRewards,
  membersAtLevel,
  removeReward,
  setLevel,
  setReward,
  topByXp,
  xpPosition,
} from "./store.js";

const MAX_LEVEL = 500;

/** Congratulates someone and hands out any reward roles they've now earned. */
async function celebrateLevelUp(message: Message<true>, level: number, bonusPoints: number) {
  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member) return;

  const earned = listRewards(message.guildId).filter((reward) => reward.level <= level);
  const newRoles: string[] = [];
  for (const reward of earned) {
    if (member.roles.cache.has(reward.role_id)) continue;
    const problem = await giveRole(member, reward.role_id, `Reached level ${reward.level}`);
    if (problem) {
      await sendStaffLog(message.guild, {
        embeds: [notice("warning", `Couldn't give ${member} their level ${reward.level} reward. ${problem}`)],
      });
    } else {
      newRoles.push(`<@&${reward.role_id}>`);
    }
  }

  const where = getSetting(message.guildId, "levelUpChannel") ?? "here";
  if (where === "off") return;
  const configured = where === "here" ? null : message.guild.channels.cache.get(where);
  const channel = configured?.isSendable() ? configured : message.channel;

  const celebration = embed(Colors.gold)
    .setThumbnail(member.displayAvatarURL())
    .setDescription(`## 🎉 Level ${level}!\n${member} just reached **level ${level}**.`)
    .addFields({ name: "Bonus", value: `+${formatPoints(bonusPoints)}`, inline: true });
  if (newRoles.length)
    celebration.addFields({
      name: newRoles.length === 1 ? "New role" : "New roles",
      value: newRoles.join(" "),
      inline: true,
    });
  try {
    await channel.send({ content: `${member}`, embeds: [celebration], allowedMentions: { users: [member.id] } });
  } catch (error) {
    console.error(`Couldn't announce a level-up in ${message.guild.name}:`, error);
  }
}

const rankCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("rank")
    .setDescription("See your level and XP (or someone else's)")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("member").setDescription("Whose rank to see (default: yours)")),

  async execute(interaction) {
    const user = interaction.options.getUser("member") ?? interaction.user;
    if (user.bot) {
      await replyNotice(interaction, "error", "Bots don't have levels.");
      return;
    }
    const member =
      interaction.options.getMember("member") ?? (user.id === interaction.user.id ? interaction.member : null);
    const stats = getLevel(interaction.guildId, user.id);
    const progress = levelProgress(stats.xp);
    const nextReward = listRewards(interaction.guildId).find((reward) => reward.level > progress.level);

    const card = embed(Colors.gold)
      .setAuthor({ name: member?.displayName ?? user.displayName, iconURL: (member ?? user).displayAvatarURL() })
      .setTitle(`Level ${progress.level}`)
      .setDescription(
        `${progressBar(progress.xpIntoLevel / progress.xpForNextLevel)}\n` +
          `**${formatNumber(progress.xpIntoLevel)}** / ${formatNumber(progress.xpForNextLevel)} XP to level ${progress.level + 1}`,
      )
      .addFields(
        {
          name: "Rank",
          value:
            stats.xp > 0
              ? `#${xpPosition(interaction.guildId, user.id)} of ${formatNumber(countWithXp(interaction.guildId))}`
              : "Unranked",
          inline: true,
        },
        { name: "Total XP", value: formatNumber(stats.xp), inline: true },
        { name: "Messages", value: formatNumber(stats.message_count), inline: true },
      )
      .setFooter({ text: "Chat to earn XP (once a minute) · Each level-up gives bonus points" });
    if (nextReward)
      card.addFields({ name: "Next reward", value: `<@&${nextReward.role_id}> at level ${nextReward.level}` });
    await interaction.reply({ embeds: [card] });
  },
};

const levelsAdmin: AdminGroup = {
  name: "levels",
  description: "Level rewards and announcements",
  build: (group) =>
    group
      .addSubcommand((sub) =>
        sub
          .setName("reward")
          .setDescription("Give a role to everyone who reaches a level")
          .addIntegerOption((o) =>
            o.setName("level").setDescription("The level").setRequired(true).setMinValue(1).setMaxValue(MAX_LEVEL),
          )
          .addRoleOption((o) => o.setName("role").setDescription("The role to give").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove-reward")
          .setDescription("Stop giving a role for reaching a level")
          .addRoleOption((o) => o.setName("role").setDescription("The reward role").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("rewards").setDescription("List the level reward roles"))
      .addSubcommand((sub) =>
        sub
          .setName("announcements")
          .setDescription("Where to announce level-ups")
          .addStringOption((o) =>
            o
              .setName("where")
              .setDescription("Where level-ups are posted")
              .setRequired(true)
              .addChoices(
                { name: "In the channel where they leveled up", value: "here" },
                { name: "In a specific channel", value: "channel" },
                { name: "Don't announce", value: "off" },
              ),
          )
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("The channel, if you picked a specific one")
              .addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set someone's level, e.g. to carry it over from another bot")
          .addUserOption((o) => o.setName("member").setDescription("Whose level to set").setRequired(true))
          .addIntegerOption((o) =>
            o
              .setName("level")
              .setDescription("Their new level")
              .setRequired(true)
              .setMinValue(0)
              .setMaxValue(MAX_LEVEL),
          ),
      ),

  async execute(interaction) {
    const { guild, guildId } = interaction;
    switch (interaction.options.getSubcommand()) {
      case "reward": {
        const level = interaction.options.getInteger("level", true);
        const role = interaction.options.getRole("role", true);
        const problem = rewardRoleProblem(role);
        if (problem) {
          await replyNotice(interaction, "error", problem);
          return;
        }
        setReward(guildId, level, role.id);

        // Hand the role to people who already passed this level, which can take a moment.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let given = 0;
        for (const userId of membersAtLevel(guildId, level)) {
          const member = await guild.members.fetch(userId).catch(() => null);
          if (
            member &&
            !member.roles.cache.has(role.id) &&
            !(await giveRole(member, role.id, `Reached level ${level}`))
          )
            given++;
        }
        const catchUp = given
          ? ` Also gave it to ${plural(given, "member")} who were already level ${level} or higher.`
          : "";
        await replyNotice(interaction, "success", `Members now get ${role} at level ${level}.${catchUp}`);
        return;
      }

      case "remove-reward": {
        const role = interaction.options.getRole("role", true);
        const removed = removeReward(guildId, role.id);
        await replyNotice(
          interaction,
          removed ? "success" : "info",
          removed
            ? `${role} is no longer a level reward. People who already have it keep it.`
            : `${role} isn't a level reward.`,
        );
        return;
      }

      case "rewards": {
        const rewards = listRewards(guildId);
        const lines = rewards.map((reward) => {
          const role = guild.roles.cache.get(reward.role_id);
          const problem = role ? rewardRoleProblem(role) : "This role was deleted.";
          return `**Level ${reward.level}** → <@&${reward.role_id}>${problem ? `\n⚠️ ${problem}` : ""}`;
        });
        const list = embed(Colors.gold)
          .setTitle("🏆 Level rewards")
          .setDescription(lines.join("\n") || "No level rewards yet. Add one with `/admin levels reward`.")
          .setFooter({ text: "Members keep every reward role they've earned" });
        await interaction.reply({ embeds: [list], flags: MessageFlags.Ephemeral });
        return;
      }

      case "announcements": {
        const where = interaction.options.getString("where", true);
        if (where === "channel") {
          const channel = interaction.options.getChannel("channel", false, [ChannelType.GuildText]);
          if (!channel) {
            await replyNotice(interaction, "error", "Pick the channel too.");
            return;
          }
          setSetting(guildId, "levelUpChannel", channel.id);
          await replyNotice(interaction, "success", `Level-ups will be announced in ${channel}.`);
        } else {
          setSetting(guildId, "levelUpChannel", where);
          await replyNotice(
            interaction,
            "success",
            where === "off"
              ? "Level-ups won't be announced. Reward roles are still given."
              : "Level-ups will be announced where they happen.",
          );
        }
        return;
      }

      case "set": {
        const user = interaction.options.getUser("member", true);
        const level = interaction.options.getInteger("level", true);
        if (user.bot) {
          await replyNotice(interaction, "error", "Bots don't have levels.");
          return;
        }
        const member = interaction.options.getMember("member");
        setLevel(guildId, user.id, member?.displayName ?? user.displayName, level);
        const problems: string[] = [];
        if (member) {
          for (const reward of listRewards(guildId).filter((reward) => reward.level <= level)) {
            const problem = await giveRole(member, reward.role_id, `Level set to ${level}`);
            if (problem) problems.push(problem);
          }
        }
        await replyNotice(
          interaction,
          "success",
          `${user} is now level ${level}.${problems.length ? `\n⚠️ ${problems.join("\n⚠️ ")}` : ""}`,
        );
        await sendStaffLog(guild, {
          embeds: [
            notice("info", `**${escapeMarkdown(interaction.member.displayName)}** set ${user}'s level to ${level}.`),
          ],
        });
        return;
      }
    }
  },
};

export const levelsBoard: Board = {
  id: "levels",
  label: "Levels",
  emoji: "🏆",
  count: countWithXp,
  rows: (guildId, limit, offset) =>
    topByXp(guildId, limit, offset).map((row) => ({
      userId: row.user_id,
      name: row.display_name,
      value: `Level ${row.level} · ${formatNumber(row.xp)} XP`,
    })),
};

export const levelsFeature: Feature = {
  name: "Levels",
  slashCommands: [rankCommand],
  admin: levelsAdmin,
  permissions: { ManageRoles: "give level reward roles" },

  async onMessage(message) {
    const result = awardMessageXp(
      message.guildId,
      message.author.id,
      message.member?.displayName ?? message.author.displayName,
    );
    if (result.awarded && result.level > result.previousLevel) {
      await celebrateLevelUp(message, result.level, result.bonusPoints);
    }
  },

  describeSettings(guild) {
    const where = getSetting(guild.id, "levelUpChannel") ?? "here";
    const rewards = listRewards(guild.id);
    const warnings = rewards.flatMap((reward) => {
      const role = guild.roles.cache.get(reward.role_id);
      const problem = role ? rewardRoleProblem(role) : `The level ${reward.level} reward role was deleted.`;
      return problem ? [`⚠️ ${problem}`] : [];
    });
    const announce = where === "here" ? "where they happen" : where === "off" ? "off" : `in <#${where}>`;
    return [
      {
        name: "🏆 Levels",
        value: [`Level-up announcements: ${announce}`, `Reward roles: ${rewards.length || "none"}`, ...warnings]
          .join("\n")
          .slice(0, 1024),
      },
    ];
  },
};
