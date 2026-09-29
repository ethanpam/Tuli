import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  OAuth2Scopes,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type PermissionsString,
} from "discord.js";
import { getSetting, getTimezone, setSetting } from "../settings.js";
import { isValidTimezone, localTime, TIMEZONES } from "../time.js";
import type { Feature } from "../types.js";
import { Colors, embed, notice, replyNotice } from "../ui.js";

/** Every permission Tuli's features need, with the reasons. */
export function collectPermissions(features: Feature[]): Map<PermissionsString, string[]> {
  const needed = new Map<PermissionsString, string[]>();
  for (const feature of features) {
    for (const [permission, reason] of Object.entries(feature.permissions ?? {})) {
      needed.set(permission as PermissionsString, [...(needed.get(permission as PermissionsString) ?? []), reason]);
    }
  }
  return needed;
}

export function inviteLink(client: Client<true>, features: Feature[], guildId?: string): string {
  return client.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: [...collectPermissions(features).keys()],
    ...(guildId ? { guild: guildId, disableGuildSelect: true } : {}),
  });
}

/** "ManageRoles" → "Manage Roles" */
function permissionName(permission: string): string {
  return permission.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Lines saying which permissions Tuli is missing in a server, and what breaks without them. */
function missingPermissions(guild: Guild, features: Feature[]): string[] {
  const me = guild.members.me;
  if (!me) return [];
  return [...collectPermissions(features)]
    .filter(([permission]) => !me.permissions.has(permission))
    .map(([permission, reasons]) => `❌ **${permissionName(permission)}** — to ${reasons.join(", ")}`);
}

/** /admin setup: the staff log channel, timezone, and an overview of every feature's settings. */
export function createSetupFeature(allFeatures: () => Feature[]): Feature {
  return {
    name: "Setup",
    permissions: {
      ViewChannel: "see channels",
      SendMessages: "post messages",
      EmbedLinks: "show embeds",
      ReadMessageHistory: "reply to messages",
    },

    describeSettings(guild) {
      const logChannelId = getSetting(guild.id, "logChannelId");
      const timezone = getTimezone(guild.id);
      return [
        { name: "📋 Staff log", value: logChannelId ? `<#${logChannelId}>` : "Not set", inline: true },
        { name: "🕒 Timezone", value: `${timezone}\n(${localTime(timezone)} there now)`, inline: true },
      ];
    },

    admin: {
      name: "setup",
      description: "Tuli's basic settings",
      build: (group) =>
        group
          .addSubcommand((sub) => sub.setName("overview").setDescription("See all of Tuli's settings and check its permissions"))
          .addSubcommand((sub) =>
            sub
              .setName("log-channel")
              .setDescription("Where Tuli posts staff alerts: scam reports, shop orders, question suggestions")
              .addChannelOption((o) =>
                o
                  .setName("channel")
                  .setDescription("A staff-only channel")
                  .addChannelTypes(ChannelType.GuildText)
                  .setRequired(true),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName("timezone")
              .setDescription("Your server's timezone, for daily resets and question schedules")
              .addStringOption((o) =>
                o.setName("timezone").setDescription("Start typing a city, e.g. Chicago").setRequired(true).setAutocomplete(true),
              ),
          ),

      async execute(interaction) {
        const { guild } = interaction;
        switch (interaction.options.getSubcommand()) {
          case "overview": {
            const features = allFeatures();
            const overview = embed()
              .setTitle("⚙️ Tuli setup")
              .setDescription("Here's how Tuli is set up in this server.")
              .addFields(features.flatMap((feature) => feature.describeSettings?.(guild) ?? []).slice(0, 24));

            const missing = missingPermissions(guild, features);
            overview.addFields({
              name: "🔐 Permissions",
              value: missing.length
                ? `${missing.join("\n")}\nUse the button below to give Tuli these permissions.`.slice(0, 1024)
                : "✅ Tuli has every permission it needs.",
            });
            if (missing.length) overview.setColor(Colors.warning);

            const components = missing.length
              ? [
                  new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                      .setStyle(ButtonStyle.Link)
                      .setLabel("Update Tuli's permissions")
                      .setURL(inviteLink(interaction.client, features, guild.id)),
                  ),
                ]
              : [];
            await interaction.reply({ embeds: [overview], components, flags: MessageFlags.Ephemeral });
            return;
          }

          case "log-channel": {
            const channel = interaction.options.getChannel("channel", true, [ChannelType.GuildText]);
            const canPost = channel
              .permissionsFor(interaction.client.user)
              ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
            if (!canPost) {
              await replyNotice(interaction, "error", `Tuli can't post in ${channel}. Give it View Channel, Send Messages and Embed Links there first.`);
              return;
            }
            setSetting(guild.id, "logChannelId", channel.id);
            await channel.send({
              embeds: [notice("info", "Tuli will post staff alerts here: scam reports, shop orders, and question suggestions.")],
            });
            await replyNotice(interaction, "success", `Staff alerts will go to ${channel}.`);
            return;
          }

          case "timezone": {
            const timezone = interaction.options.getString("timezone", true);
            if (!isValidTimezone(timezone)) {
              await replyNotice(interaction, "error", `"${timezone}" isn't a timezone I know. Pick one from the list as you type.`);
              return;
            }
            setSetting(guild.id, "timezone", timezone);
            await replyNotice(interaction, "success", `Timezone set to **${timezone}**. It's ${localTime(timezone)} there now.`);
            return;
          }
        }
      },

      async autocomplete(interaction) {
        const typed = interaction.options.getFocused().toLowerCase().replaceAll(" ", "_");
        const matches = TIMEZONES.filter((timezone) => timezone.toLowerCase().includes(typed)).slice(0, 25);
        await interaction.respond(matches.map((timezone) => ({ name: `${timezone} (${localTime(timezone)})`, value: timezone })));
      },
    },
  };
}
