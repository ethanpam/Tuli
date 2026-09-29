import { db } from "../../db.js";

export interface Quote {
  id: number;
  guild_id: string;
  number: number;
  text: string;
  author_id: string | null;
  author_name: string;
  added_by_id: string;
  channel_id: string | null;
  message_id: string | null;
  created_at: number;
}

export type NewQuote = Omit<Quote, "id" | "number">;

// Numbers the quote in the same statement that inserts it, so two saves can't get the same number.
const insert = db.prepare(`
  INSERT INTO quotes (guild_id, number, text, author_id, author_name, added_by_id, channel_id, message_id, created_at)
  SELECT $guild_id, COALESCE(MAX(number), 0) + 1, $text, $author_id, $author_name, $added_by_id, $channel_id, $message_id, $created_at
  FROM quotes WHERE guild_id = $guild_id
  RETURNING *`);
const selectByNumber = db.prepare("SELECT * FROM quotes WHERE guild_id = $guildId AND number = $number");
const selectByMessage = db.prepare("SELECT * FROM quotes WHERE guild_id = $guildId AND message_id = $messageId");
const selectRandom = db.prepare(`
  SELECT * FROM quotes
  WHERE guild_id = $guildId AND ($authorId IS NULL OR author_id = $authorId)
  ORDER BY RANDOM() LIMIT 1`);
const selectByAuthor = db.prepare("SELECT * FROM quotes WHERE guild_id = $guildId AND author_id = $authorId");
const selectPage = db.prepare(`
  SELECT * FROM quotes
  WHERE guild_id = $guildId AND ($authorId IS NULL OR author_id = $authorId)
  ORDER BY number LIMIT $limit OFFSET $offset`);
const selectCount = db.prepare(`
  SELECT COUNT(*) AS count FROM quotes
  WHERE guild_id = $guildId AND ($authorId IS NULL OR author_id = $authorId)`);
const selectLatestAuthorName = db.prepare(`
  SELECT author_name FROM quotes
  WHERE guild_id = $guildId AND author_id = $authorId
  ORDER BY number DESC LIMIT 1`);
const deleteByNumber = db.prepare("DELETE FROM quotes WHERE guild_id = $guildId AND number = $number");

// Ignores capitalization, extra spaces, and quote marks around the text.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "");
}

export function addQuote(quote: NewQuote): Quote {
  // RETURNING always gives back the inserted row.
  return insert.get(quote) as unknown as Quote;
}

export function getQuote(guildId: string, number: number): Quote | undefined {
  return selectByNumber.get({ guildId, number }) as Quote | undefined;
}

export function findQuoteByMessage(guildId: string, messageId: string): Quote | undefined {
  return selectByMessage.get({ guildId, messageId }) as Quote | undefined;
}

export function randomQuote(guildId: string, authorId?: string): Quote | undefined {
  return selectRandom.get({ guildId, authorId: authorId ?? null }) as Quote | undefined;
}

/** An existing quote from the same person that says the same thing, if any. */
export function findDuplicateQuote(guildId: string, authorId: string, text: string): Quote | undefined {
  const key = normalize(text);
  const quotes = selectByAuthor.all({ guildId, authorId }) as unknown as Quote[];
  return quotes.find((quote) => normalize(quote.text) === key);
}

export function listQuotes(guildId: string, authorId: string | undefined, limit: number, offset: number): Quote[] {
  return selectPage.all({ guildId, authorId: authorId ?? null, limit, offset }) as unknown as Quote[];
}

export function countQuotes(guildId: string, authorId?: string): number {
  const { count } = selectCount.get({ guildId, authorId: authorId ?? null }) as { count: number };
  return count;
}

/** The name someone had on their newest quote (names are saved with each quote and can change). */
export function latestAuthorName(guildId: string, authorId: string): string | undefined {
  const row = selectLatestAuthorName.get({ guildId, authorId }) as { author_name: string } | undefined;
  return row?.author_name;
}

export function deleteQuote(guildId: string, number: number): void {
  deleteByNumber.run({ guildId, number });
}
