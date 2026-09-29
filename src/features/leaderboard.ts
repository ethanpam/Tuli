import { escapeMarkdown, InteractionContextType, SlashCommandBuilder } from "discord.js";
import type { Feature } from "../types.js";
import { clampPage, Colors, embed, pageButtons, pageCountFor, plural, rankLabel, replyNotice } from "../ui.js";

const PAGE_SIZE = 10;
const PREFIX = "leaderboard";

/** Something people can be ranked by, like points or XP. */
export interface Board {
  id: string;
  label: string;
  emoji: string;
  count(guildId: string): number;
  rows(guildId: string, limit: number, offset: number): { userId: string; name: string | null; value: string }[];
}

export function createLeaderboardFeature(boards: Board[]): Feature {
  const boardsById = new Map(boards.map((board) => [board.id, board]));
  const [defaultBoard] = boards;
  if (!defaultBoard) throw new Error("A leaderboard needs at least one board");

  function leaderboardPage(guildId: string, board: Board, requestedPage: number) {
    const total = board.count(guildId);
    const pageCount = pageCountFor(total, PAGE_SIZE);
    const page = clampPage(requestedPage, pageCount);
    const lines = board.rows(guildId, PAGE_SIZE, page * PAGE_SIZE).map((row, index) => {
      const name = row.name ? `**${escapeMarkdown(row.name)}**` : `<@${row.userId}>`;
      return `${rankLabel(page * PAGE_SIZE + index + 1)} ${name} — ${row.value}`;
    });
    const leaderboard = embed(Colors.gold)
      .setTitle(`${board.emoji} ${board.label} leaderboard`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `Page ${page + 1} of ${pageCount} · ${plural(total, "member")} ranked` });
    return { embeds: [leaderboard], components: pageButtons(PREFIX, page, pageCount, [board.id]) };
  }

  return {
    name: "Leaderboard",
    slashCommands: [
      {
        data: new SlashCommandBuilder()
          .setName("leaderboard")
          .setDescription("See who's on top")
          .setContexts(InteractionContextType.Guild)
          .addStringOption((o) =>
            o
              .setName("board")
              .setDescription(`Which leaderboard (default: ${defaultBoard.label})`)
              .addChoices(boards.map((board) => ({ name: `${board.emoji} ${board.label}`, value: board.id }))),
          ),
        async execute(interaction) {
          const board = boardsById.get(interaction.options.getString("board") ?? defaultBoard.id) ?? defaultBoard;
          if (board.count(interaction.guildId) === 0) {
            await replyNotice(interaction, "info", `Nobody's on the ${board.label.toLowerCase()} leaderboard yet.`);
            return;
          }
          await interaction.reply(leaderboardPage(interaction.guildId, board, 0));
        },
      },
    ],
    components: [
      {
        prefix: PREFIX,
        async execute(interaction, [page = "0", boardId = defaultBoard.id]) {
          const board = boardsById.get(boardId) ?? defaultBoard;
          await interaction.update(leaderboardPage(interaction.guildId, board, Number(page)));
        },
      },
    ],
  };
}
