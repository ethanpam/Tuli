import type {
  APIEmbedField,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  Guild,
  Message,
  MessageComponentInteraction,
  MessageContextMenuCommandInteraction,
  PermissionsString,
  RESTPostAPIApplicationCommandsJSONBody,
  SlashCommandSubcommandGroupBuilder,
} from "discord.js";

// Every interaction Tuli handles happens inside a server ("cached" guild), so handlers
// can use interaction.guild and interaction.member without null checks.

interface CommandData {
  name: string;
  toJSON(): RESTPostAPIApplicationCommandsJSONBody;
}

/** A command people type, like /quote. */
export interface SlashCommand {
  data: CommandData;
  execute(interaction: ChatInputCommandInteraction<"cached">): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction<"cached">): Promise<void>;
}

/** A command in a message's right-click → Apps menu. */
export interface MessageCommand {
  data: CommandData;
  execute(interaction: MessageContextMenuCommandInteraction<"cached">): Promise<void>;
}

/**
 * Handles buttons and select menus whose custom ID is `prefix:arg1:arg2...`. Everything
 * the handler needs is in the ID, so components keep working after Tuli restarts.
 */
export interface ComponentHandler {
  prefix: string;
  execute(interaction: MessageComponentInteraction<"cached">, args: string[]): Promise<void>;
}

/** A group of staff-only subcommands under /admin, e.g. /admin shop add. */
export interface AdminGroup {
  name: string;
  description: string;
  build(group: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder;
  execute(interaction: ChatInputCommandInteraction<"cached">): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction<"cached">): Promise<void>;
}

/** Returned by a message handler to stop later features from seeing the message (e.g. it was a scam). */
export const STOP = Symbol("stop");

/** One area of Tuli (quotes, levels, shop...). Everything it adds to the bot is declared here. */
export interface Feature {
  name: string;
  slashCommands?: SlashCommand[];
  messageCommands?: MessageCommand[];
  components?: ComponentHandler[];
  admin?: AdminGroup;
  /** Runs for every message a person (not a bot) sends in a server. */
  onMessage?(message: Message<true>): Promise<typeof STOP | void>;
  /** Runs once when Tuli connects, e.g. to start timers. */
  onReady?(client: Client<true>): void;
  /** Discord permissions this feature needs, and what for (shown in /admin setup overview). */
  permissions?: Partial<Record<PermissionsString, string>>;
  /** Fields for the /admin setup overview. */
  describeSettings?(guild: Guild): APIEmbedField[];
}
