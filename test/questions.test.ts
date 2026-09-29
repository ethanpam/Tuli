import assert from "node:assert/strict";
import { test } from "node:test";
import { cronFor, describeSchedule, isDue } from "../src/features/questions/schedule.js";
import {
  addQuestion,
  approveSuggestion,
  claimNextQuestion,
  countByStatus,
  findWaitingDuplicate,
  latestPosted,
  questionForThread,
  recordAnswer,
  recordPost,
  rejectSuggestion,
  removeQuestion,
  unclaimQuestion,
} from "../src/features/questions/store.js";

test("questions are posted oldest first and numbered per server", () => {
  addQuestion("q1", "First?", "admin", "queued");
  addQuestion("q1", "Second?", "admin", "queued");
  addQuestion("q2", "Other server?", "admin", "queued");
  const first = claimNextQuestion("q1");
  assert.deepEqual([first?.text, first?.number, first?.status], ["First?", 1, "posted"]);
  assert.equal(claimNextQuestion("q1")?.number, 2);
  assert.equal(claimNextQuestion("q1"), undefined, "queue is empty");
  assert.equal(claimNextQuestion("q2")?.number, 1);
  assert.equal(latestPosted("q1")?.text, "Second?");
});

test("a question that failed to post goes back to the front of the queue", () => {
  addQuestion("q3", "Retry me?", "admin", "queued");
  addQuestion("q3", "After?", "admin", "queued");
  const claimed = claimNextQuestion("q3")!;
  unclaimQuestion(claimed.id);
  assert.equal(countByStatus("q3", "queued"), 2);
  assert.deepEqual([claimNextQuestion("q3")?.text, latestPosted("q3")?.number], ["Retry me?", 1]);
});

test("duplicates are caught ignoring case, spacing and trailing punctuation", () => {
  addQuestion("q4", "What's your favorite food?", "a", "queued");
  assert.ok(findWaitingDuplicate("q4", "what's your   favorite food"));
  assert.ok(findWaitingDuplicate("q4", "WHAT'S YOUR FAVORITE FOOD?!"));
  assert.equal(findWaitingDuplicate("q4", "What's your favorite drink?"), undefined);
  claimNextQuestion("q4");
  assert.equal(findWaitingDuplicate("q4", "What's your favorite food?"), undefined, "posted questions can be asked again");
});

test("suggestions are approved into the queue or rejected, once", () => {
  const good = addQuestion("q5", "Good idea?", "member", "suggested");
  const bad = addQuestion("q5", "Bad idea?", "member", "suggested");
  assert.equal(claimNextQuestion("q5"), undefined, "suggestions aren't posted until approved");
  assert.equal(approveSuggestion("q5", good.id), true);
  assert.equal(approveSuggestion("q5", good.id), false, "already approved");
  assert.equal(rejectSuggestion("q5", bad.id), true);
  assert.equal(rejectSuggestion("q5", bad.id), false);
  assert.equal(claimNextQuestion("q5")?.text, "Good idea?");
});

test("only waiting questions can be removed", () => {
  const waiting = addQuestion("q6", "Remove me?", "a", "queued");
  const posted = addQuestion("q6", "Keep me?", "a", "queued");
  assert.equal(removeQuestion("q6", waiting.id), true);
  claimNextQuestion("q6");
  assert.equal(removeQuestion("q6", posted.id), false);
});

test("answers count once per person, found by thread", () => {
  const question = addQuestion("q7", "Answer me?", "a", "queued");
  claimNextQuestion("q7");
  recordPost(question.id, "channel", "message", "thread-7");
  assert.equal(questionForThread("thread-7")?.id, question.id);
  assert.equal(recordAnswer(question.id, "alex"), true);
  assert.equal(recordAnswer(question.id, "alex"), false);
  assert.equal(recordAnswer(question.id, "sam"), true);
});

test("schedules become due once per slot and catch up once after downtime", () => {
  const daily = { frequency: "daily" as const, weekday: 1, hour: 9 };
  const weekly = { frequency: "weekly" as const, weekday: 5, hour: 18 };
  assert.equal(cronFor(daily), "0 9 * * *");
  assert.equal(cronFor(weekly), "0 18 * * 5");
  assert.equal(describeSchedule(weekly), "every Friday at 6 PM");

  const tz = "America/Chicago";
  const lastRun = Date.parse("2026-09-29T13:00:00Z"); // 8 AM Chicago
  assert.equal(isDue(daily, tz, lastRun, Date.parse("2026-09-29T13:59:00Z")), false, "8:59 AM: not yet");
  assert.equal(isDue(daily, tz, lastRun, Date.parse("2026-09-29T14:00:00Z")), true, "9:00 AM: due");
  // Offline for three days: due (once — the caller then records the run time).
  assert.equal(isDue(daily, tz, lastRun, Date.parse("2026-10-02T20:00:00Z")), true);
  assert.equal(isDue(daily, tz, Date.parse("2026-10-02T20:00:00Z"), Date.parse("2026-10-02T20:00:30Z")), false);
});
