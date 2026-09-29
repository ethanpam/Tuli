import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  escapeMarkdown,
  InteractionContextType,
  MessageFlags,
  messageLink,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Client,
  type EmbedBuilder,
  type User,
} from "discord.js";
import type { ComponentHandler, Feature, MessageCommand, SlashCommand } from "../../types.js";
import {
  clampPage,
  commandMention,
  embed,
  oneLine,
  pageButtons,
  pageCountFor,
  plural,
  replyNotice,
  truncate,
} from "../../ui.js";
import {
  addQuote,
  countQuotes,
  deleteQuote,
  findDuplicateQuote,
  findQuoteByMessage,
  getQuote,
  latestAuthorName,
  listQuotes,
  randomQuote,
  type Quote,
} from "./store.js";

// Discord's normal message limit. Keeps quotes readable and well under the embed limit.
const MAX_QUOTE_LENGTH = 2000;
const PAGE_SIZE = 10;
const PREVIEW_LENGTH = 80;
const LIST_PREFIX = "quote-list";

function quoteEmbed(quote: Quote): EmbedBuilder {
  let attribution = `— **${escapeMarkdown(quote.author_name)}**`;
  if (quote.channel_id && quote.message_id) {
    attribution += ` · [Jump to message](${messageLink(quote.channel_id, quote.message_id, quote.guild_id)})`;
  }
  return embed()
    .setDescription(`“${quote.text}”\n\n${attribution}`)
    .setFooter({ text: `Quote #${quote.number}` })
    .setTimestamp(quote.created_at);
}

function noQuotesMessage(client: Client<true>, author: User | null): string {
  if (author) return `No quotes from ${author.displayName} yet.`;
  return `No quotes yet. Add one with ${commandMention(client, "quote add")}, or right-click a message → Apps → **Save as quote**.`;
}

/** One page of the quote directory, with ◀ ▶ buttons when there's more than one page. */
function quoteListPage(guildId: string, authorId: string | undefined, requestedPage: number) {
  const total = countQuotes(guildId, authorId);
  const pageCount = pageCountFor(total, PAGE_SIZE);
  const page = clampPage(requestedPage, pageCount);
  const quotes = listQuotes(guildId, authorId, PAGE_SIZE, page * PAGE_SIZE);

  const lines = quotes.map((quote) => {
    const preview = escapeMarkdown(truncate(oneLine(quote.text), PREVIEW_LENGTH));
    return `\`#${quote.number}\` “${preview}” — ${escapeMarkdown(quote.author_name)}`;
  });
  // Names are saved with each quote, so use their newest one to keep the title the same on every page.
  const authorName = authorId && latestAuthorName(guildId, authorId);
  const listEmbed = embed()
    .setTitle(authorName ? `💬 Quotes from ${authorName}` : "💬 All quotes")
    .setDescription(lines.join("\n") || "No quotes here anymore.")
    .setFooter({ text: `Page ${page + 1} of ${pageCount} · ${plural(total, "quote")} · /quote show to see one in full` });
  return { embeds: [listEmbed], components: pageButtons(LIST_PREFIX, page, pageCount, [authorId ?? ""]) };
}

const quoteCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("quote")
    .setDescription("Save and share memorable quotes")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Save something someone said")
        .addStringOption((o) =>
          o.setName("text").setDescription("What they said").setRequired(true).setMaxLength(MAX_QUOTE_LENGTH),
        )
        .addUserOption((o) => o.setName("by").setDescription("Who said it").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("random")
        .setDescription("Share a random quote")
        .addUserOption((o) => o.setName("by").setDescription("Only quotes from this person")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("Browse all saved quotes")
        .addUserOption((o) => o.setName("by").setDescription("Only quotes from this person")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("Show a specific quote")
        .addIntegerOption((o) =>
          o.setName("number").setDescription("The number under the quote").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Delete a quote")
        .addIntegerOption((o) =>
          o.setName("number").setDescription("The number under the quote").setRequired(true).setMinValue(1),
        ),
    ),

  async execute(interaction) {
    const { guildId } = interaction;

    switch (interaction.options.getSubcommand()) {
      case "add": {
        const author = interaction.options.getUser("by", true);
        const text = interaction.options.getString("text", true);
        if (author.bot) {
          await replyNotice(interaction, "error", "Quotes are for people, not bots.");
          return;
        }
        const duplicate = findDuplicateQuote(guildId, author.id, text);
        if (duplicate) {
          await replyNotice(interaction, "info", `That's already saved as quote #${duplicate.number}.`, [quoteEmbed(duplicate)]);
          return;
        }
        const saved = addQuote({
          guild_id: guildId,
          text,
          author_id: author.id,
          author_name: interaction.options.getMember("by")?.displayName ?? author.displayName,
          added_by_id: interaction.user.id,
          channel_id: null,
          message_id: null,
          created_at: Date.now(),
        });
        await interaction.reply({
          content: `📌 **${escapeMarkdown(interaction.member.displayName)}** saved a quote`,
          embeds: [quoteEmbed(saved)],
        });
        return;
      }

      case "random": {
        const author = interaction.options.getUser("by");
        const found = randomQuote(guildId, author?.id);
        if (!found) {
          await replyNotice(interaction, "info", noQuotesMessage(interaction.client, author));
          return;
        }
        await interaction.reply({ embeds: [quoteEmbed(found)] });
        return;
      }

      case "list": {
        const author = interaction.options.getUser("by");
        if (countQuotes(guildId, author?.id) === 0) {
          await replyNotice(interaction, "info", noQuotesMessage(interaction.client, author));
          return;
        }
        await interaction.reply({ ...quoteListPage(guildId, author?.id, 0), flags: MessageFlags.Ephemeral });
        return;
      }

      case "show": {
        const number = interaction.options.getInteger("number", true);
        const found = getQuote(guildId, number);
        if (!found) {
          await replyNotice(interaction, "error", `There's no quote #${number}.`);
          return;
        }
        await interaction.reply({ embeds: [quoteEmbed(found)] });
        return;
      }

      case "delete": {
        const number = interaction.options.getInteger("number", true);
        const found = getQuote(guildId, number);
        if (!found) {
          await replyNotice(interaction, "error", `There's no quote #${number}.`);
          return;
        }
        const canDelete =
          found.added_by_id === interaction.user.id ||
          found.author_id === interaction.user.id ||
          interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages);
        if (!canDelete) {
          await replyNotice(
            interaction,
            "error",
            "Only the person who saved this quote, the person quoted, or a moderator can delete it.",
          );
          return;
        }
        deleteQuote(guildId, number);
        await replyNotice(interaction, "success", `Deleted quote #${number}.`);
        return;
      }
    }
  },
};

const saveQuoteCommand: MessageCommand = {
  data: new ContextMenuCommandBuilder()
    .setName("Save as quote")
    .setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const message = interaction.targetMessage;

    if (message.author.bot) {
      await replyNotice(interaction, "error", "Quotes are for people, not bots.");
      return;
    }
    if (!message.content) {
      await replyNotice(interaction, "error", "That message has no text to quote.");
      return;
    }
    if (message.content.length > MAX_QUOTE_LENGTH) {
      await replyNotice(interaction, "error", `That message is too long to quote (max ${MAX_QUOTE_LENGTH} characters).`);
      return;
    }
    const existing =
      findQuoteByMessage(interaction.guildId, message.id) ??
      findDuplicateQuote(interaction.guildId, message.author.id, message.content);
    if (existing) {
      await replyNotice(interaction, "info", `That's already saved as quote #${existing.number}.`, [quoteEmbed(existing)]);
      return;
    }

    const saved = addQuote({
      guild_id: interaction.guildId,
      text: message.content,
      author_id: message.author.id,
      author_name: message.member?.displayName ?? message.author.displayName,
      added_by_id: interaction.user.id,
      channel_id: message.channelId,
      message_id: message.id,
      created_at: message.createdTimestamp,
    });
    await interaction.reply({
      content: `📌 **${escapeMarkdown(interaction.member.displayName)}** saved a quote`,
      embeds: [quoteEmbed(saved)],
    });
  },
};

const quoteListButtons: ComponentHandler = {
  prefix: LIST_PREFIX,
  async execute(interaction, [page = "0", authorId = ""]) {
    await interaction.update(quoteListPage(interaction.guildId, authorId || undefined, Number(page)));
  },
};

export const quotesFeature: Feature = {
  name: "Quotes",
  slashCommands: [quoteCommand],
  messageCommands: [saveQuoteCommand],
  components: [quoteListButtons],
};
