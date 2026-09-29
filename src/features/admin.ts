import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { AdminGroup, Feature } from "../types.js";

/**
 * Builds /admin out of each feature's staff subcommands (/admin shop add, /admin level reward...).
 * Only members with Manage Server can see or use it; server owners can change that in
 * Server Settings → Integrations → Tuli.
 */
export function createAdminFeature(groups: AdminGroup[]): Feature {
  const data = new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Set up and manage Tuli")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  for (const group of groups) {
    data.addSubcommandGroup((builder) => group.build(builder.setName(group.name).setDescription(group.description)));
  }
  const groupsByName = new Map(groups.map((group) => [group.name, group]));

  return {
    name: "Admin",
    slashCommands: [
      {
        data,
        async execute(interaction) {
          await groupsByName.get(interaction.options.getSubcommandGroup(true))?.execute(interaction);
        },
        async autocomplete(interaction) {
          const group = interaction.options.getSubcommandGroup();
          if (group) await groupsByName.get(group)?.autocomplete?.(interaction);
        },
      },
    ],
  };
}
