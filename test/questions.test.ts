import assert from "node:assert/strict";
import { test } from "node:test";
import { getBalance } from "../src/features/economy/store.js";
import { readChoices } from "../src/features/questions/index.js";
import { cronFor, describeSchedule, isDue } from "../src/features/questions/schedule.js";
import {
  addQuestion,
  ANSWER_POINTS,
  answerOf,
  approveSuggestion,
  choiceCounts,
  claimNextQuestion,
  closeQuestion,
  countByStatus,
  findWaitingDuplicate,
  getQuestion,
  latestPosted,
  questionForThread,
  recordAnswer,
  recordPost,
  rejectSuggestion,
  removeQuestion,
  TRUE_FALSE,
  unclaimQuestion,
  unclosedQuestions,
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
  assert.equal(
    findWaitingDuplicate("q4", "What's your favorite food?"),
    undefined,
    "posted questions can be asked again",
  );
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

test("multiple-choice and true/false questions keep their choices and answer", () => {
  const choice = addQuestion("q8", "Best dining hall?", "a", "queued", {
    kind: "choice",
    choices: ["Seasons", "UDM", "Conversations"],
    answer: null,
  });
  const truefalse = addQuestion("q8", "Cy is a cardinal.", "a", "queued", {
    kind: "truefalse",
    choices: TRUE_FALSE,
    answer: 0,
  });
  const open = addQuestion("q8", "Favorite class?", "a", "queued");
  assert.deepEqual([choice.kind, choice.choices, choice.answer], ["choice", ["Seasons", "UDM", "Conversations"], null]);
  assert.deepEqual([truefalse.kind, truefalse.choices, truefalse.answer], ["truefalse", ["True", "False"], 0]);
  assert.deepEqual([open.kind, open.choices, open.answer], ["open", [], null]);
  assert.deepEqual(claimNextQuestion("q8")?.choices, ["Seasons", "UDM", "Conversations"], "choices survive posting");
});

test("button answers lock in and are counted per choice", () => {
  const question = addQuestion("q9", "Pick one", "a", "queued", {
    kind: "choice",
    choices: ["A", "B", "C"],
    answer: 1,
  });
  assert.equal(recordAnswer(question.id, "alex", 1), true);
  assert.equal(recordAnswer(question.id, "alex", 2), false, "can't change an answer");
  assert.equal(answerOf(question.id, "alex"), 1);
  assert.equal(answerOf(question.id, "nobody"), undefined);
  recordAnswer(question.id, "sam", 0);
  recordAnswer(question.id, "kim", 1);
  assert.deepEqual(choiceCounts(question), [1, 2, 0]);
});

test("closing trivia pays everyone who was right, exactly once", () => {
  const trivia = addQuestion("q10", "2 + 2?", "a", "queued", { kind: "choice", choices: ["3", "4"], answer: 1 });
  const posted = claimNextQuestion("q10")!;
  recordAnswer(trivia.id, "right", 1);
  recordAnswer(trivia.id, "wrong", 0);
  assert.deepEqual(
    unclosedQuestions("q10").map((q) => q.id),
    [trivia.id],
  );

  assert.deepEqual(closeQuestion(posted), { winners: ["right"] });
  assert.equal(closeQuestion(posted), null, "already closed");
  assert.equal(getBalance("q10", "right"), ANSWER_POINTS);
  assert.equal(getBalance("q10", "wrong"), 0);
  assert.deepEqual(unclosedQuestions("q10"), []);
});

test("polls have no winners, and open questions are never waiting to close", () => {
  const poll = addQuestion("q11", "Tea or coffee?", "a", "queued", {
    kind: "choice",
    choices: ["Tea", "Coffee"],
    answer: null,
  });
  addQuestion("q11", "Open one?", "a", "queued");
  claimNextQuestion("q11");
  claimNextQuestion("q11");
  recordAnswer(poll.id, "alex", 0);
  assert.deepEqual(
    unclosedQuestions("q11").map((q) => q.id),
    [poll.id],
  );
  assert.deepEqual(closeQuestion(getQuestion("q11", poll.id)!), { winners: [] });
  assert.equal(getBalance("q11", "alex"), 0, "closing a poll pays nothing (votes are paid when cast)");
});

test("add-choice choices must be filled in order and be different", () => {
  const from = (values: Record<string, string>) => readChoices((name) => values[name] ?? null);
  assert.deepEqual(from({ "choice-a": "Yes", "choice-b": " No " }), { choices: ["Yes", "No"] });
  assert.deepEqual(from({ "choice-a": "1", "choice-b": "2", "choice-c": "3", "choice-d": "4", "choice-e": "5" }), {
    choices: ["1", "2", "3", "4", "5"],
  });
  assert.ok("problem" in from({ "choice-a": "1", "choice-b": "2", "choice-d": "4" }), "gap at C");
  assert.ok("problem" in from({ "choice-a": "Same", "choice-b": "same" }), "duplicates");
});
