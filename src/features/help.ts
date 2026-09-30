import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ApplicationCommand,
} from "discord.js";
import type { Feature } from "../types.js";
import { geminiConfig } from "./chat/gemini.js";
import { getSetting } from "../settings.js";
import { Colors, embed, truncate } from "../ui.js";

interface Section {
  title: string;
  lines: string[];
}

function line(command: ApplicationCommand, path: string, description: string): string {
  // The </name:id> format renders as a clickable command in Discord.
  return `</${path}:${command.id}> — ${description}`;
}

/**
 * A command's subcommands, grouped: /quote → one section of "/quote add", "/quote random"...;
 * /admin → one section per group ("/admin shop", "/admin levels"...).
 */
export function commandSections(command: ApplicationCommand): Section[] {
  const loose: string[] = [];
  const groups: Section[] = [];
  for (const option of command.options) {
    if (option.type === ApplicationCommandOptionType.Subcommand) {
      loose.push(line(command, `${command.name} ${option.name}`, option.description));
    } else if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
      groups.push({
        title: `/${command.name} ${option.name}`,
        lines: (option.options ?? []).map((sub) =>
          line(command, `${command.name} ${option.name} ${sub.name}`, sub.description),
        ),
      });
    }
  }
  if (loose.length === 0 && groups.length === 0) loose.push(line(command, command.name, command.description));
  return [...(loose.length ? [{ title: `/${command.name}`, lines: loose }] : []), ...groups];
}

export const helpFeature: Feature = {
  name: "Help",
  slashCommands: [
    {
      data: new SlashCommandBuilder()
        .setName("tuli")
        .setDescription("See everything Tuli can do")
        .setContexts(InteractionContextType.Guild),

      async execute(interaction) {
        // Filled in when Tuli registers its commands on startup, so this list is never out of date.
        const commands = [...interaction.client.application.commands.cache.values()]
          .filter((command) => command.name !== "tuli")
          // Staff commands only show up for people who can use them.
          .filter(
            (command) =>
              !command.defaultMemberPermissions || interaction.memberPermissions.has(command.defaultMemberPermissions),
          )
          .sort((a, b) => a.name.localeCompare(b.name));

        const slash = commands.filter((command) => command.type === ApplicationCommandType.ChatInput);
        const chatting = !!geminiConfig() && (getSetting(interaction.guildId, "aiEnabled") ?? false);
        const everyone = slash
          .filter((command) => !command.defaultMemberPermissions)
          .flatMap(commandSections)
          .flatMap((section) => section.lines);
        const messageMenus = commands
          .filter((command) => command.type === ApplicationCommandType.Message)
          .map((command) => `**${command.name}** — right-click a message → Apps`);

        const embeds = [
          embed()
            .setAuthor({ name: "Tuli", iconURL: interaction.client.user.displayAvatarURL() })
            .setTitle("Here's what I can do")
            .setDescription(
              truncate(
                [
                  chatting
                    ? "Click a command to use it, or mention @Tuli to chat (reply to keep the conversation going).\n-# Chatting uses Google Gemini, so what you say to Tuli is sent to Google."
                    : "Click a command to use it. You can also mention @Tuli to say hi.",
                  "",
                  ...everyone,
                  ...messageMenus,
                ].join("\n"),
                4096,
              ),
            ),
        ];

        const staff = slash.filter((command) => command.defaultMemberPermissions).flatMap(commandSections);
        if (staff.length) {
          embeds.push(
            embed(Colors.warning)
              .setTitle("Staff commands")
              .setDescription("Only people with the right permissions can see these.")
              .addFields(
                staff
                  .slice(0, 25)
                  .map((section) => ({ name: section.title, value: truncate(section.lines.join("\n"), 1024) })),
              ),
          );
        }
        await interaction.reply({ embeds, flags: MessageFlags.Ephemeral });
      },
    },
  ],
};
