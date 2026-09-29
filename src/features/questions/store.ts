import { db, transaction } from "../../db.js";

export interface Question {
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
}

const insertQuestion = db.prepare(`
  INSERT INTO questions (guild_id, text, status, added_by_id, created_at)
  VALUES ($guildId, $text, $status, $addedBy, $now) RETURNING *`);
const selectQuestion = db.prepare("SELECT * FROM questions WHERE guild_id = $guildId AND id = $id");
const selectWaiting = db.prepare("SELECT * FROM questions WHERE guild_id = $guildId AND status IN ('queued', 'suggested')");
const selectByStatus = db.prepare(
  "SELECT * FROM questions WHERE guild_id = $guildId AND status = $status ORDER BY id LIMIT $limit OFFSET $offset",
);
const selectCountByStatus = db.prepare("SELECT COUNT(*) AS count FROM questions WHERE guild_id = $guildId AND status = $status");
const selectOldestQueued = db.prepare("SELECT * FROM questions WHERE guild_id = $guildId AND status = 'queued' ORDER BY id LIMIT 1");
const selectNextNumber = db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM questions WHERE guild_id = $guildId");
const markPosted = db.prepare(
  "UPDATE questions SET status = 'posted', number = $number, posted_at = $now WHERE id = $id RETURNING *",
);
const markQueued = db.prepare("UPDATE questions SET status = 'queued', number = NULL, posted_at = NULL WHERE id = $id");
const setPost = db.prepare("UPDATE questions SET channel_id = $channelId, message_id = $messageId, thread_id = $threadId WHERE id = $id");
const approve = db.prepare("UPDATE questions SET status = 'queued' WHERE guild_id = $guildId AND id = $id AND status = 'suggested'");
const deleteWaiting = db.prepare("DELETE FROM questions WHERE guild_id = $guildId AND id = $id AND status IN ('queued', 'suggested')");
const deleteSuggestion = db.prepare("DELETE FROM questions WHERE guild_id = $guildId AND id = $id AND status = 'suggested'");
const selectByThread = db.prepare("SELECT * FROM questions WHERE thread_id = $threadId");
const selectLatestPosted = db.prepare("SELECT * FROM questions WHERE guild_id = $guildId AND status = 'posted' ORDER BY number DESC LIMIT 1");
const insertAnswer = db.prepare("INSERT OR IGNORE INTO question_answers (question_id, user_id) VALUES ($questionId, $userId)");
const selectAnswerCount = db.prepare("SELECT COUNT(*) AS count FROM question_answers WHERE question_id = $questionId");

// Ignores capitalization, punctuation at the end, and extra spaces.
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[\s?!.]+$/, "").trim();
}

export function addQuestion(guildId: string, text: string, addedBy: string, status: "queued" | "suggested"): Question {
  return insertQuestion.get({ guildId, text: text.trim(), status, addedBy, now: Date.now() }) as unknown as Question;
}

/** A queued or suggested question that asks the same thing, if any. */
export function findWaitingDuplicate(guildId: string, text: string): Question | undefined {
  const key = normalize(text);
  return (selectWaiting.all({ guildId }) as unknown as Question[]).find((question) => normalize(question.text) === key);
}

export function getQuestion(guildId: string, id: number): Question | undefined {
  return selectQuestion.get({ guildId, id }) as Question | undefined;
}

export function listByStatus(guildId: string, status: Question["status"], limit: number, offset = 0): Question[] {
  return selectByStatus.all({ guildId, status, limit, offset }) as unknown as Question[];
}

export function countByStatus(guildId: string, status: Question["status"]): number {
  return (selectCountByStatus.get({ guildId, status }) as { count: number }).count;
}

/** Takes the oldest queued question and numbers it, ready to post. */
export function claimNextQuestion(guildId: string): Question | undefined {
  return transaction(() => {
    const next = selectOldestQueued.get({ guildId }) as Question | undefined;
    if (!next) return undefined;
    const { next: number } = selectNextNumber.get({ guildId }) as { next: number };
    return markPosted.get({ id: next.id, number, now: Date.now() }) as unknown as Question;
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
  return selectByThread.get({ threadId }) as Question | undefined;
}

export function latestPosted(guildId: string): Question | undefined {
  return selectLatestPosted.get({ guildId }) as Question | undefined;
}

/** Records an answer. Returns true only for someone's first answer to a question. */
export function recordAnswer(questionId: number, userId: string): boolean {
  return insertAnswer.run({ questionId, userId }).changes > 0;
}

export function countAnswers(questionId: number): number {
  return (selectAnswerCount.get({ questionId }) as { count: number }).count;
}
