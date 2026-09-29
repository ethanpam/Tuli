import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  time,
  TimestampStyles,
  type Guild,
  type GuildMember,
  type Message,
  type MessageComponentInteraction,
} from "discord.js";
import { getSetting, setSetting } from "../../settings.js";
import { sendStaffLog } from "../../staff-log.js";
import { STOP, type AdminGroup, type ComponentHandler, type Feature, type SlashCommand } from "../../types.js";
import { Colors, embed, notice, plural, replyNotice, truncate } from "../../ui.js";
import { checkMessage, RepeatTracker, repeatKey } from "./detector.js";
import { addWarning, deleteWarning, listWarnings } from "./store.js";

const DEFAULT_TIMEOUT_MINUTES = 24 * 60;
const TIMEOUT_CHOICES = [
  { name: "Don't time out", value: 0 },
  { name: "10 minutes", value: 10 },
  { name: "1 hour", value: 60 },
  { name: "6 hours", value: 6 * 60 },
  { name: "1 day", value: 24 * 60 },
  { name: "1 week", value: 7 * 24 * 60 },
];

const tracker = new RepeatTracker();

function durationLabel(minutes: number): string {
  return TIMEOUT_CHOICES.find((choice) => choice.value === minutes)?.name ?? plural(minutes, "minute");
}

function timeoutMinutes(guildId: string): number {
  return getSetting(guildId, "scamTimeoutMinutes") ?? DEFAULT_TIMEOUT_MINUTES;
}

/** Message text in a code block, safe from breaking out of it. */
function quoted(content: string): string {
  return content ? `\`\`\`\n${truncate(content.replaceAll("```", "`​``"), 1000)}\n\`\`\`` : "*(attachments only)*";
}

function memberFields(member: GuildMember) {
  return [
    { name: "Member", value: `${member}\n${escapeMarkdown(member.user.username)} · \`${member.id}\``, inline: true },
    { name: "Account created", value: time(member.user.createdAt, TimestampStyles.RelativeTime), inline: true },
    { name: "Joined", value: member.joinedAt ? time(member.joinedAt, TimestampStyles.RelativeTime) : "Unknown", inline: true },
  ];
}

async function timeOut(member: GuildMember, minutes: number, reason: string): Promise<boolean> {
  if (minutes <= 0 || !member.moderatable) return false;
  return member.timeout(minutes * 60_000, reason).then(
    () => true,
    () => false,
  );
}

async function warnHackedAccount(member: GuildMember, minutes: number, timedOut: boolean) {
  const muted = timedOut ? ` and muted you for ${durationLabel(minutes)}` : "";
  await member
    .send({
      embeds: [
        notice(
          "warning",
          `A message you sent in **${escapeMarkdown(member.guild.name)}** looked like a scam, so Tuli removed it${muted}.\n\n` +
            "**If you didn't send it, your account may be hacked.** Change your Discord password, turn on two-factor authentication, " +
            "then let the server's staff know.",
        ),
      ],
    })
    .catch(() => {});
}

/** Deletes every copy of a scam, times the sender out, and reports it to staff. */
async function blockScam(message: Message<true>, member: GuildMember, reasons: string[], copies: { channelId: string; messageId: string }[]) {
  const { guild } = message;
  let deleted = 0;
  for (const copy of new Map(copies.map((c) => [c.messageId, c])).values()) {
    const channel = guild.channels.cache.get(copy.channelId);
    if (!channel?.isTextBased()) continue;
    await channel.messages.delete(copy.messageId).then(
      () => deleted++,
      () => {},
    );
  }
  const minutes = timeoutMinutes(guild.id);
  const timedOut = await timeOut(member, minutes, `Tuli: ${reasons[0]}`);
  await warnHackedAccount(member, minutes, timedOut);

  const channels = [...new Set(copies.map((c) => `<#${c.channelId}>`))].join(" ");
  const done = [`Deleted ${plural(deleted, "message")}`, timedOut ? `timed out for ${durationLabel(minutes)}` : minutes ? "couldn't time out (Tuli's role may be too low)" : ""];
  const report = embed(Colors.danger)
    .setTitle("🚨 Blocked a likely scam")
    .setThumbnail(member.displayAvatarURL())
    .addFields(
      ...memberFields(member),
      { name: "Why", value: reasons.map((reason) => `• ${reason}`).join("\n") },
      { name: "Where", value: channels },
      { name: "Message", value: quoted(message.content) },
      { name: "Done", value: done.filter(Boolean).join(" · ") },
    )
    .setTimestamp();
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mod:ban:${member.id}`).setLabel("Ban").setStyle(ButtonStyle.Danger),
  );
  if (timedOut) buttons.addComponents(new ButtonBuilder().setCustomId(`mod:untimeout:${member.id}`).setLabel("Remove timeout").setStyle(ButtonStyle.Secondary));
  await sendStaffLog(guild, { embeds: [report], components: [buttons] });
}

/** Asks staff to look at something suspicious without acting on it. */
async function flagForReview(message: Message<true>, member: GuildMember, reasons: string[]) {
  const report = embed(Colors.warning)
    .setTitle("⚠️ Possible scam")
    .setThumbnail(member.displayAvatarURL())
    .addFields(
      ...memberFields(member),
      { name: "Why", value: reasons.map((reason) => `• ${reason}`).join("\n") },
      { name: "Message", value: `${quoted(message.content)}\n[Jump to message](${message.url})` },
    )
    .setTimestamp();
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mod:punish:${member.id}:${message.channelId}:${message.id}`).setLabel("Delete & time out").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("mod:dismiss").setLabel("Looks fine").setStyle(ButtonStyle.Secondary),
  );
  await sendStaffLog(message.guild, { embeds: [report], components: [buttons] });
}

/** Adds a "Handled" line to a report and removes its buttons. */
async function closeReport(interaction: MessageComponentInteraction<"cached">, outcome: string, messageId = interaction.message.id) {
  const message = messageId === interaction.message.id ? interaction.message : await interaction.channel?.messages.fetch(messageId).catch(() => null);
  const [original] = message?.embeds ?? [];
  if (!message || !original) return;
  const updated = EmbedBuilder.from(original).addFields({ name: "Handled", value: `${outcome} by ${interaction.user}` });
  if (messageId === interaction.message.id) await interaction.update({ embeds: [updated], components: [] });
  else await message.edit({ embeds: [updated], components: [] });
}

const REQUIRED: Record<string, bigint> = {
  ban: PermissionFlagsBits.BanMembers,
  "ban-confirm": PermissionFlagsBits.BanMembers,
  untimeout: PermissionFlagsBits.ModerateMembers,
  punish: PermissionFlagsBits.ModerateMembers,
  dismiss: PermissionFlagsBits.ModerateMembers,
};

const reportButtons: ComponentHandler = {
  prefix: "mod",
  async execute(interaction, [action = "", userId = "", ...rest]) {
    const needed = REQUIRED[action];
    if (!needed || !interaction.memberPermissions.has(needed)) {
      await replyNotice(interaction, "error", "You don't have permission to do that.");
      return;
    }
    const { guild } = interaction;

    switch (action) {
      case "ban": {
        // Ask first, so a misclick can't ban anyone.
        const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`mod:ban-confirm:${userId}:${interaction.message.id}`).setLabel("Yes, ban them").setStyle(ButtonStyle.Danger),
        );
        await interaction.reply({
          embeds: [notice("warning", `Ban <@${userId}> and delete their messages from the last day?`)],
          components: [confirm],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      case "ban-confirm": {
        const [reportId] = rest;
        const banned = await guild.members
          .ban(userId, { deleteMessageSeconds: 24 * 60 * 60, reason: `Scam, banned by ${interaction.user.username} via Tuli` })
          .then(() => true, () => false);
        if (!banned) {
          await interaction.update({ embeds: [notice("error", "Discord wouldn't let Tuli ban them. Tuli's role may be below theirs.")], components: [] });
          return;
        }
        await interaction.update({ embeds: [notice("success", `Banned <@${userId}>.`)], components: [] });
        if (reportId) await closeReport(interaction, "🔨 Banned", reportId);
        return;
      }
      case "untimeout": {
        const member = await guild.members.fetch(userId).catch(() => null);
        await member?.timeout(null, `Timeout removed by ${interaction.user.username} via Tuli`).catch(() => {});
        await closeReport(interaction, "✅ Timeout removed");
        return;
      }
      case "punish": {
        const [channelId = "", messageId = ""] = rest;
        const channel = guild.channels.cache.get(channelId);
        if (channel?.isTextBased()) await channel.messages.delete(messageId).catch(() => {});
        const member = await guild.members.fetch(userId).catch(() => null);
        const minutes = timeoutMinutes(guild.id) || 60;
        const timedOut = member ? await timeOut(member, minutes, `Scam, confirmed by ${interaction.user.username}`) : false;
        if (member) await warnHackedAccount(member, minutes, timedOut);
        await closeReport(interaction, timedOut ? `🗑️ Deleted and timed out for ${durationLabel(minutes)}` : "🗑️ Deleted");
        return;
      }
      case "dismiss": {
        await closeReport(interaction, "👍 Marked as fine");
        return;
      }
    }
  },
};

const modCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("mod")
    .setDescription("Moderator tools")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((sub) =>
      sub
        .setName("warn")
        .setDescription("Warn someone (they get a DM, and it's kept on record)")
        .addUserOption((o) => o.setName("member").setDescription("Who to warn").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Why").setRequired(true).setMaxLength(300)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("warnings")
        .setDescription("See someone's warnings")
        .addUserOption((o) => o.setName("member").setDescription("Whose warnings").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unwarn")
        .setDescription("Remove a warning")
        .addIntegerOption((o) => o.setName("id").setDescription("The warning ID from /mod warnings").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("purge")
        .setDescription("Delete recent messages in this channel")
        .addIntegerOption((o) => o.setName("amount").setDescription("How many (up to 100)").setRequired(true).setMinValue(1).setMaxValue(100))
        .addUserOption((o) => o.setName("member").setDescription("Only delete this person's messages")),
    ),

  async execute(interaction) {
    const { guild } = interaction;
    const moderator = escapeMarkdown(interaction.member.displayName);

    switch (interaction.options.getSubcommand()) {
      case "warn": {
        const user = interaction.options.getUser("member", true);
        const reason = interaction.options.getString("reason", true);
        if (user.bot) {
          await replyNotice(interaction, "error", "Bots can't be warned.");
          return;
        }
        addWarning(guild.id, user.id, interaction.user.id, reason);
        const count = listWarnings(guild.id, user.id).length;
        const dm = await user
          .send({ embeds: [notice("warning", `You were warned in **${escapeMarkdown(guild.name)}**: ${escapeMarkdown(reason)}`)] })
          .then(() => true, () => false);
        await replyNotice(interaction, "success", `Warned ${user} (warning #${count}).${dm ? "" : " They have DMs off, so they weren't told."}`);
        await sendStaffLog(guild, { embeds: [notice("warning", `**${moderator}** warned ${user} (warning #${count}): ${escapeMarkdown(reason)}`)] });
        return;
      }

      case "warnings": {
        const user = interaction.options.getUser("member", true);
        const warnings = listWarnings(guild.id, user.id);
        const lines = warnings.map(
          (warning) =>
            `\`ID ${warning.id}\` ${escapeMarkdown(warning.reason)}\n-# by <@${warning.moderator_id}> ${time(Math.floor(warning.created_at / 1000), TimestampStyles.RelativeTime)}`,
        );
        const list = embed(warnings.length ? Colors.warning : Colors.success)
          .setTitle(`${user.displayName}: ${plural(warnings.length, "warning")}`)
          .setDescription(truncate(lines.join("\n") || "No warnings. 🎉", 4096));
        await interaction.reply({ embeds: [list], flags: MessageFlags.Ephemeral });
        return;
      }

      case "unwarn": {
        const warning = deleteWarning(guild.id, interaction.options.getInteger("id", true));
        if (!warning) {
          await replyNotice(interaction, "error", "There's no warning with that ID.");
          return;
        }
        await replyNotice(interaction, "success", `Removed a warning from <@${warning.user_id}>: ${escapeMarkdown(warning.reason)}`);
        await sendStaffLog(guild, { embeds: [notice("info", `**${moderator}** removed a warning from <@${warning.user_id}>: ${escapeMarkdown(warning.reason)}`)] });
        return;
      }

      case "purge": {
        const channel = interaction.channel;
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages) || !channel || channel.isDMBased()) {
          await replyNotice(interaction, "error", "You need Manage Messages to purge.");
          return;
        }
        const amount = interaction.options.getInteger("amount", true);
        const target = interaction.options.getUser("member");
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const recent = await channel.messages.fetch({ limit: 100 });
        const toDelete = [...recent.filter((message) => !target || message.author.id === target.id).values()].slice(0, amount);
        // Discord only bulk-deletes messages younger than two weeks.
        const deleted = await channel.bulkDelete(toDelete, true).then(
          (removed) => removed.size,
          () => 0,
        );
        const skipped = toDelete.length - deleted;
        await replyNotice(
          interaction,
          deleted ? "success" : "error",
          `Deleted ${plural(deleted, "message")}${target ? ` from ${target}` : ""}.${skipped ? ` ${plural(skipped, "message")} were older than two weeks, which Discord doesn't allow bulk-deleting.` : ""}`,
        );
        if (deleted) await sendStaffLog(guild, { embeds: [notice("info", `**${moderator}** purged ${plural(deleted, "message")}${target ? ` from ${target}` : ""} in ${channel}.`)] });
        return;
      }
    }
  },
};

const protectionAdmin: AdminGroup = {
  name: "protection",
  description: "Scam protection",
  build: (group) =>
    group
      .addSubcommand((sub) =>
        sub
          .setName("configure")
          .setDescription("Turn scam protection on or off, and choose the timeout")
          .addBooleanOption((o) => o.setName("enabled").setDescription("Delete likely scams automatically"))
          .addIntegerOption((o) => o.setName("timeout").setDescription("How long to time out whoever posted it").addChoices(TIMEOUT_CHOICES)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("test")
          .setDescription("See what Tuli would do with a message, without posting it")
          .addStringOption((o) => o.setName("message").setDescription("The message text").setRequired(true)),
      ),

  async execute(interaction) {
    const { guildId } = interaction;
    if (interaction.options.getSubcommand() === "test") {
      const verdict = checkMessage({ content: interaction.options.getString("message", true), canMentionEveryone: false });
      const text = !verdict
        ? "Tuli would let this through."
        : `Tuli would ${verdict.action === "block" ? "**delete it and time out the sender**" : "**flag it for staff**"}:\n${verdict.reasons.map((r) => `• ${r}`).join("\n")}`;
      await replyNotice(interaction, verdict ? "warning" : "success", text);
      return;
    }

    const enabled = interaction.options.getBoolean("enabled");
    const timeout = interaction.options.getInteger("timeout");
    if (enabled !== null) setSetting(guildId, "scamProtection", enabled);
    if (timeout !== null) setSetting(guildId, "scamTimeoutMinutes", timeout);
    const on = getSetting(guildId, "scamProtection") ?? true;
    const minutes = timeoutMinutes(guildId);
    await replyNotice(
      interaction,
      "success",
      on
        ? `Scam protection is **on**. Tuli deletes likely scams${minutes ? ` and times out the sender for ${durationLabel(minutes)}` : ""}.`
        : "Scam protection is **off**.",
    );
  },
};

function canReadMessages(guild: Guild): boolean {
  return guild.client.options.intents.has(GatewayIntentBits.MessageContent);
}

export const moderationFeature: Feature = {
  name: "Moderation",
  slashCommands: [modCommand],
  components: [reportButtons],
  admin: protectionAdmin,
  permissions: {
    ManageMessages: "delete scams and purge messages",
    ModerateMembers: "time out scammers",
    BanMembers: "ban people from scam reports",
  },

  onReady() {
    setInterval(() => tracker.sweep(Date.now()), 5 * 60_000);
  },

  async onMessage(message) {
    if (getSetting(message.guildId, "scamProtection") === false || !canReadMessages(message.guild)) return;
    const member = message.member;
    if (!member || member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

    const verdict = checkMessage({
      content: message.content,
      canMentionEveryone: message.channel.permissionsFor(member).has(PermissionFlagsBits.MentionEveryone),
    });
    const key = repeatKey(message.content, [...message.attachments.values()].map((file) => `${file.name}:${file.size}`));
    const burst = key
      ? tracker.record(message.guildId, member.id, { channelId: message.channelId, messageId: message.id, key, at: message.createdTimestamp })
      : null;

    if (burst || verdict?.action === "block") {
      const reasons = [...(verdict?.action === "block" ? verdict.reasons : [])];
      if (burst) reasons.push(`Posted the same message in ${new Set(burst.map((m) => m.channelId)).size} channels within a minute`);
      await blockScam(message, member, reasons, burst ?? [{ channelId: message.channelId, messageId: message.id }]);
      return STOP;
    }
    if (verdict?.action === "flag") await flagForReview(message, member, verdict.reasons);
  },

  describeSettings(guild) {
    const on = getSetting(guild.id, "scamProtection") ?? true;
    const minutes = timeoutMinutes(guild.id);
    const lines = [on ? `On · ${minutes ? `times out for ${durationLabel(minutes)}` : "deletes without timing out"}` : "Off"];
    if (on && !canReadMessages(guild)) {
      lines.push("⚠️ Tuli can't read messages yet. Turn on **Message Content Intent** in the Discord Developer Portal → Bot, then restart Tuli.");
    }
    if (on && !getSetting(guild.id, "logChannelId")) lines.push("⚠️ Set a staff log channel to see what Tuli blocks.");
    return [{ name: "🛡️ Scam protection", value: lines.join("\n") }];
  },
};

