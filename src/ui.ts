import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type Client,
  type CommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from "discord.js";

/** Tuli's palette. Every embed uses one of these so the bot looks consistent. */
export const Colors = {
  brand: 0x5b8def,
  success: 0x3ba55c,
  warning: 0xf0b232,
  danger: 0xed4245,
  gold: 0xf1c40f,
} as const;

export const POINTS_EMOJI = "🪙";

export function embed(color: number = Colors.brand): EmbedBuilder {
  return new EmbedBuilder().setColor(color);
}

const noticeStyles = {
  success: { color: Colors.success, icon: "✅" },
  error: { color: Colors.danger, icon: "❌" },
  warning: { color: Colors.warning, icon: "⚠️" },
  info: { color: Colors.brand, icon: "ℹ️" },
} as const;

export type NoticeKind = keyof typeof noticeStyles;

/** A short colored message, e.g. notice("error", "You don't have enough points."). */
export function notice(kind: NoticeKind, text: string): EmbedBuilder {
  const style = noticeStyles[kind];
  return embed(style.color).setDescription(`${style.icon} ${text}`);
}

type Repliable = CommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;

/** Answers an interaction with a notice only the user can see, whatever state the interaction is in. */
export async function replyNotice(
  interaction: Repliable,
  kind: NoticeKind,
  text: string,
  extraEmbeds: EmbedBuilder[] = [],
): Promise<void> {
  const embeds = [notice(kind, text), ...extraEmbeds];
  if (interaction.deferred && !interaction.replied) await interaction.editReply({ embeds, components: [] });
  else if (interaction.replied) await interaction.followUp({ embeds, flags: MessageFlags.Ephemeral });
  else await interaction.reply({ embeds, flags: MessageFlags.Ephemeral });
}

/**
 * A clickable command, e.g. commandMention(client, "quote add") → </quote add:123>.
 * Falls back to plain `/quote add` if Tuli hasn't registered its commands yet.
 */
export function commandMention(client: Client<true>, path: string): string {
  const name = path.split(" ")[0];
  const id = client.application.commands.cache.find((command) => command.name === name)?.id;
  return id ? `</${path}:${id}>` : `\`/${path}\``;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatPoints(value: number): string {
  return `${POINTS_EMOJI} ${formatNumber(value)}`;
}

/** plural(1, "quote") → "1 quote", plural(3, "quote") → "3 quotes" */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : pluralForm}`;
}

/** Collapses newlines and repeated spaces so text fits on one line of a list. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** progressBar(0.5, 10) → "▰▰▰▰▰▱▱▱▱▱" */
export function progressBar(fraction: number, width = 12): string {
  const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** 🥇 🥈 🥉 for the top three, then #4, #5... */
export function rankLabel(position: number): string {
  return ["🥇", "🥈", "🥉"][position - 1] ?? `**#${position}**`;
}

export function pageCountFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Keeps a requested page in range, e.g. when items were deleted since the buttons were made. */
export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(Math.trunc(page) || 0, 0), pageCount - 1);
}

/**
 * ◀ ▶ buttons for a paged list, or nothing if it fits on one page.
 * Each button's ID is `prefix:targetPage:...args`, so the handler gets [page, ...args].
 */
export function pageButtons(
  prefix: string,
  page: number,
  pageCount: number,
  args: string[] = [],
): ActionRowBuilder<ButtonBuilder>[] {
  if (pageCount <= 1) return [];
  const button = (label: string, target: number) =>
    new ButtonBuilder()
      .setCustomId([prefix, target, ...args].join(":"))
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(target < 0 || target >= pageCount);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(button("◀ Previous", page - 1), button("Next ▶", page + 1)),
  ];
}
