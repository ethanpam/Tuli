import type { Interaction, Message, RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { STOP, type ComponentHandler, type Feature, type MessageCommand, type SlashCommand } from "./types.js";
import { replyNotice } from "./ui.js";

/** Sends each interaction and message to the feature that handles it. */
export function createRouter(features: Feature[]) {
  const slashCommands = new Map<string, SlashCommand>();
  const messageCommands = new Map<string, MessageCommand>();
  const components = new Map<string, ComponentHandler>();
  for (const feature of features) {
    for (const command of feature.slashCommands ?? []) slashCommands.set(command.data.name, command);
    for (const command of feature.messageCommands ?? []) messageCommands.set(command.data.name, command);
    for (const handler of feature.components ?? []) components.set(handler.prefix, handler);
  }

  function describe(interaction: Interaction): string {
    if (interaction.isCommand() || interaction.isAutocomplete()) return `/${interaction.commandName}`;
    if (interaction.isMessageComponent()) return `Component ${interaction.customId}`;
    return `Interaction ${interaction.type}`;
  }

  return {
    commandData(): RESTPostAPIApplicationCommandsJSONBody[] {
      return [...slashCommands.values(), ...messageCommands.values()].map((command) => command.data.toJSON());
    },

    async handleInteraction(interaction: Interaction): Promise<void> {
      if (!interaction.inCachedGuild()) {
        if (interaction.isRepliable()) {
          await replyNotice(interaction, "error", "Tuli only works inside a server.").catch(() => {});
        }
        return;
      }
      try {
        if (interaction.isChatInputCommand()) {
          await slashCommands.get(interaction.commandName)?.execute(interaction);
        } else if (interaction.isAutocomplete()) {
          await slashCommands.get(interaction.commandName)?.autocomplete?.(interaction);
        } else if (interaction.isMessageContextMenuCommand()) {
          await messageCommands.get(interaction.commandName)?.execute(interaction);
        } else if (interaction.isMessageComponent()) {
          const [prefix = "", ...args] = interaction.customId.split(":");
          await components.get(prefix)?.execute(interaction, args);
        }
      } catch (error) {
        console.error(`${describe(interaction)} failed:`, error);
        if (interaction.isRepliable()) {
          await replyNotice(interaction, "error", "Something went wrong on Tuli's end. Please try again.").catch(
            () => {},
          );
        }
      }
    },

    async handleMessage(message: Message): Promise<void> {
      if (message.author.bot || message.system || !message.inGuild()) return;
      for (const feature of features) {
        if (!feature.onMessage) continue;
        try {
          if ((await feature.onMessage(message)) === STOP) return;
        } catch (error) {
          console.error(`${feature.name} message handler failed:`, error);
        }
      }
    },
  };
}
