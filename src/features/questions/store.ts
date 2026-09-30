import { db, transaction } from "../../db.js";
import { changePoints } from "../economy/store.js";

/** "open" = answered in a thread; "choice" and "truefalse" = answered with buttons. */
export type QuestionKind = "open" | "choice" | "truefalse";

export interface QuestionFormat {
  kind: QuestionKind;
  /** What people pick from (empty for open questions). */
  choices: string[];
  /** Index of the right answer, or null for a poll with no right answer. */
  answer: number | null;
}

export const OPEN_QUESTION: QuestionFormat = { kind: "open", choices: [], answer: null };
export const TRUE_FALSE = ["True", "False"];

export interface Question extends QuestionFormat {
  id: number;
  guild_id: string;
  text: string;
  status: "suggested" | "queued" | "posted";
  added_by_id: string;
  created_at: number;
  number: number | null;
  posted_at: number | null;
  channel_id: string | null;
  message_id: string | null;
  thread_id: string | null;
  /** When the results of a button question were revealed. */
  closed_at: number | null;
}

type QuestionRow = Omit<Question, "choices"> & { choices: string | null };

function fromRow(row: unknown): Question {
  const { choices, ...rest } = row as QuestionRow;
  return { ...rest, choices: choices ? (JSON.parse(choices) as string[]) : [] };
}

function maybeQuestion(row: unknown): Question | undefined {
  return row ? fromRow(row) : undefined;
}

const insertQuestion = db.prepare(`
  INSERT INTO questions (guild_id, text, status, added_by_id, created_at, kind, choices, answer)
  VALUES ($guildId, $text, $status, $addedBy, $now, $kind, $choices, $answer) RETURNING *`);
const selectQuestion = db.prepare("SELECT * FROM questions WHERE guild_id = $guildId AND id = $id");
const selectWaiting = db.prepare(
  "SELECT * FROM questions WHERE guild_id = $guildId AND status IN ('queued', 'suggested')",
);
const selectByStatus = db.prepare(
  "SELECT * FROM questions WHERE guild_id = $guildId AND status = $status ORDER BY id LIMIT $limit OFFSET $offset",
);
const selectCountByStatus = db.prepare(
  "SELECT COUNT(*) AS count FROM questions WHERE guild_id = $guildId AND status = $status",
);
const selectOldestQueued = db.prepare(
  "SELECT * FROM questions WHERE guild_id = $guildId AND status = 'queued' ORDER BY id LIMIT 1",
);
const selectNextNumber = db.prepare(
  "SELECT COALESCE(MAX(number), 0) + 1 AS next FROM questions WHERE guild_id = $guildId",
);
const markPosted = db.prepare(
  "UPDATE questions SET status = 'posted', number = $number, posted_at = $now WHERE id = $id RETURNING *",
);
const markQueued = db.prepare("UPDATE questions SET status = 'queued', number = NULL, posted_at = NULL WHERE id = $id");
const setPost = db.prepare(
  "UPDATE questions SET channel_id = $channelId, message_id = $messageId, thread_id = $threadId WHERE id = $id",
);
const approve = db.prepare(
  "UPDATE questions SET status = 'queued' WHERE guild_id = $guildId AND id = $id AND status = 'suggested'",
);
const deleteWaiting = db.prepare(
  "DELETE FROM questions WHERE guild_id = $guildId AND id = $id AND status IN ('queued', 'suggested')",
);
const deleteSuggestion = db.prepare(
  "DELETE FROM questions WHERE guild_id = $guildId AND id = $id AND status = 'suggested'",
);
const selectByThread = db.prepare("SELECT * FROM questions WHERE thread_id = $threadId");
const selectLatestPosted = db.prepare(
  "SELECT * FROM questions WHERE guild_id = $guildId AND status = 'posted' ORDER BY number DESC LIMIT 1",
);
const insertAnswer = db.prepare(
  "INSERT OR IGNORE INTO question_answers (question_id, user_id, choice) VALUES ($questionId, $userId, $choice)",
);
const selectAnswerCount = db.prepare("SELECT COUNT(*) AS count FROM question_answers WHERE question_id = $questionId");
const selectAnswer = db.prepare(
  "SELECT choice FROM question_answers WHERE question_id = $questionId AND user_id = $userId",
);
const selectChoiceCounts = db.prepare(
  "SELECT choice, COUNT(*) AS count FROM question_answers WHERE question_id = $questionId GROUP BY choice",
);
const selectChosenBy = db.prepare(
  "SELECT user_id FROM question_answers WHERE question_id = $questionId AND choice = $choice",
);
const selectUnclosed = db.prepare(`
  SELECT * FROM questions
  WHERE guild_id = $guildId AND status = 'posted' AND kind != 'open' AND closed_at IS NULL ORDER BY id`);
const markClosed = db.prepare("UPDATE questions SET closed_at = $now WHERE id = $id AND closed_at IS NULL");

// Ignores capitalization, punctuation at the end, and extra spaces.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s?!.]+$/, "")
    .trim();
}

export function addQuestion(
  guildId: string,
  text: string,
  addedBy: string,
  status: "queued" | "suggested",
  format: QuestionFormat = OPEN_QUESTION,
): Question {
  return fromRow(
    insertQuestion.get({
      guildId,
      text: text.trim(),
      status,
      addedBy,
      now: Date.now(),
      kind: format.kind,
      choices: format.choices.length ? JSON.stringify(format.choices) : null,
      answer: format.answer,
    }),
  );
}

/** A queued or suggested question that asks the same thing, if any. */
export function findWaitingDuplicate(guildId: string, text: string): Question | undefined {
  const key = normalize(text);
  return selectWaiting
    .all({ guildId })
    .map(fromRow)
    .find((question) => normalize(question.text) === key);
}

export function getQuestion(guildId: string, id: number): Question | undefined {
  return maybeQuestion(selectQuestion.get({ guildId, id }));
}

export function listByStatus(guildId: string, status: Question["status"], limit: number, offset = 0): Question[] {
  return selectByStatus.all({ guildId, status, limit, offset }).map(fromRow);
}

export function countByStatus(guildId: string, status: Question["status"]): number {
  return (selectCountByStatus.get({ guildId, status }) as { count: number }).count;
}

/** Takes the oldest queued question and numbers it, ready to post. */
export function claimNextQuestion(guildId: string): Question | undefined {
  return transaction(() => {
    const next = maybeQuestion(selectOldestQueued.get({ guildId }));
    if (!next) return undefined;
    const { next: number } = selectNextNumber.get({ guildId }) as { next: number };
    return fromRow(markPosted.get({ id: next.id, number, now: Date.now() }));
  });
}

/** Puts a claimed question back at the front of the queue, e.g. when posting it failed. */
export function unclaimQuestion(id: number): void {
  markQueued.run({ id });
}

export function recordPost(id: number, channelId: string, messageId: string, threadId: string | null): void {
  setPost.run({ id, channelId, messageId, threadId });
}

export function approveSuggestion(guildId: string, id: number): boolean {
  return approve.run({ guildId, id }).changes > 0;
}

export function rejectSuggestion(guildId: string, id: number): boolean {
  return deleteSuggestion.run({ guildId, id }).changes > 0;
}

/** Removes a question that hasn't been posted yet. */
export function removeQuestion(guildId: string, id: number): boolean {
  return deleteWaiting.run({ guildId, id }).changes > 0;
}

export function questionForThread(threadId: string): Question | undefined {
  return maybeQuestion(selectByThread.get({ threadId }));
}

export function latestPosted(guildId: string): Question | undefined {
  return maybeQuestion(selectLatestPosted.get({ guildId }));
}

/**
 * Records an answer (for button questions, which choice they picked). Returns true only
 * for someone's first answer, so answers can't be changed.
 */
export function recordAnswer(questionId: number, userId: string, choice: number | null = null): boolean {
  return insertAnswer.run({ questionId, userId, choice }).changes > 0;
}

/** Which choice someone picked, null for a thread answer, or undefined if they haven't answered. */
export function answerOf(questionId: number, userId: string): number | null | undefined {
  const row = selectAnswer.get({ questionId, userId }) as { choice: number | null } | undefined;
  return row?.choice;
}

/** How many people picked each choice, in order. */
export function choiceCounts(question: Question): number[] {
  const counts = question.choices.map(() => 0);
  for (const row of selectChoiceCounts.all({ questionId: question.id }) as { choice: number | null; count: number }[]) {
    if (row.choice !== null && row.choice < counts.length) counts[row.choice] = row.count;
  }
  return counts;
}

/** Posted button questions whose results haven't been revealed yet. */
export function unclosedQuestions(guildId: string): Question[] {
  return selectUnclosed.all({ guildId }).map(fromRow);
}

/** Points for a first thread answer, a poll vote, or a right trivia answer. */
export const ANSWER_POINTS = 10;

/**
 * Closes a button question and, for trivia, gives everyone who picked the right answer
 * their points. Returns who won, or null if it was already closed.
 */
export function closeQuestion(question: Question): { winners: string[] } | null {
  return transaction(() => {
    if (markClosed.run({ id: question.id, now: Date.now() }).changes === 0) return null;
    if (question.answer === null) return { winners: [] };
    const winners = (
      selectChosenBy.all({ questionId: question.id, choice: question.answer }) as { user_id: string }[]
    ).map((row) => row.user_id);
    for (const userId of winners) {
      changePoints({
        guildId: question.guild_id,
        userId,
        amount: ANSWER_POINTS,
        reason: `Right answer to question #${question.number}`,
      });
    }
    return { winners };
  });
}

export function countAnswers(questionId: number): number {
  return (selectAnswerCount.get({ questionId }) as { count: number }).count;
}
