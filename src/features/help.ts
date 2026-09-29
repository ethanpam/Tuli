import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ApplicationCommand,
} from "discord.js";
import type { Feature } from "../types.js";
import { embed, truncate } from "../ui.js";

// Turns /quote into one line per subcommand ("/quote add", "/quote random", ...).
// The </name:id> format renders as a clickable command in Discord.
export function commandLines(command: ApplicationCommand): string[] {
  const entries = command.options.flatMap((option) => {
    if (option.type === ApplicationCommandOptionType.Subcommand) {
      return [{ path: `${command.name} ${option.name}`, description: option.description }];
    }
    if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
      return (option.options ?? []).map((sub) => ({
        path: `${command.name} ${option.name} ${sub.name}`,
        description: sub.description,
      }));
    }
    return [];
  });
  if (entries.length === 0) entries.push({ path: command.name, description: command.description });
  return entries.map(({ path, description }) => `</${path}:${command.id}> — ${description}`);
}

function section(title: string, lines: string[]): string {
  return lines.length ? `**${title}**\n${lines.join("\n")}` : "";
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
          .filter((command) => !command.defaultMemberPermissions || interaction.memberPermissions.has(command.defaultMemberPermissions))
          .sort((a, b) => a.name.localeCompare(b.name));

        const slash = commands.filter((command) => command.type === ApplicationCommandType.ChatInput);
        const everyone = slash.filter((command) => !command.defaultMemberPermissions).flatMap(commandLines);
        const staff = slash.filter((command) => command.defaultMemberPermissions).flatMap(commandLines);
        const messageMenus = commands
          .filter((command) => command.type === ApplicationCommandType.Message)
          .map((command) => `**${command.name}** — right-click a message → Apps`);

        const description = [
          "Click a command to use it. You can also mention @Tuli to say hi.",
          section("Commands", [...everyone, ...messageMenus]),
          section("Staff only", staff),
        ]
          .filter(Boolean)
          .join("\n\n");

        const reply = embed()
          .setAuthor({ name: "Tuli", iconURL: interaction.client.user.displayAvatarURL() })
          .setTitle("Here's what I can do")
          .setDescription(truncate(description, 4096));
        await interaction.reply({ embeds: [reply], flags: MessageFlags.Ephemeral });
      },
    },
  ],
};
