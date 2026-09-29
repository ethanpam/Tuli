import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changePoints,
  claimDaily,
  countWithPoints,
  currentStreak,
  dailyAmount,
  getBalance,
  NotEnoughPointsError,
  pointsPosition,
  recentTransactions,
  topByPoints,
  transferPoints,
} from "../src/features/economy/store.js";

test("points can be given and taken, but never below zero", () => {
  assert.equal(changePoints({ guildId: "e1", userId: "a", amount: 100, reason: "Gift" }), 100);
  assert.equal(changePoints({ guildId: "e1", userId: "a", amount: -30, reason: "Oops" }), 70);
  assert.throws(
    () => changePoints({ guildId: "e1", userId: "a", amount: -71, reason: "Too much" }),
    NotEnoughPointsError,
  );
  assert.equal(getBalance("e1", "a"), 70, "failed change leaves the balance alone");
  assert.deepEqual(
    recentTransactions("e1", "a", 10).map((t) => [t.amount, t.reason]),
    [
      [-30, "Oops"],
      [100, "Gift"],
    ],
  );
});

test("transfers move points both ways or not at all", () => {
  changePoints({ guildId: "e2", userId: "a", amount: 50, reason: "Start" });
  const result = transferPoints("e2", { id: "a", name: "Alex" }, { id: "b", name: "Sam" }, 20, "lunch");
  assert.deepEqual(result, { fromBalance: 30, toBalance: 20 });
  assert.equal(recentTransactions("e2", "b", 1)[0]?.reason, "From Alex: lunch");
  assert.throws(
    () => transferPoints("e2", { id: "a", name: "Alex" }, { id: "b", name: "Sam" }, 31),
    NotEnoughPointsError,
  );
  assert.equal(getBalance("e2", "a"), 30);
  assert.equal(getBalance("e2", "b"), 20);
});

test("daily rewards grow with a streak and reset after a missed day", () => {
  assert.deepEqual([1, 2, 5, 6, 30].map(dailyAmount), [50, 60, 90, 100, 100]);
  const claim = (today: string, yesterday: string) => claimDaily("e3", "a", "Alex", today, yesterday);

  assert.deepEqual(claim("2026-10-01", "2026-09-30"), { claimed: true, amount: 50, streak: 1, balance: 50 });
  assert.deepEqual(claim("2026-10-01", "2026-09-30"), { claimed: false, streak: 1 }, "once per day");
  assert.deepEqual(claim("2026-10-02", "2026-10-01"), { claimed: true, amount: 60, streak: 2, balance: 110 });
  assert.equal(currentStreak("e3", "a", "2026-10-03", "2026-10-02"), 2, "streak is alive the next day");
  assert.equal(currentStreak("e3", "a", "2026-10-04", "2026-10-03"), 0, "and gone after a missed day");
  assert.deepEqual(claim("2026-10-04", "2026-10-03"), { claimed: true, amount: 50, streak: 1, balance: 160 });
});

test("leaderboard order and positions, with ties broken consistently", () => {
  changePoints({ guildId: "e4", userId: "low", amount: 10, reason: "x" });
  changePoints({ guildId: "e4", userId: "tie-b", amount: 50, reason: "x" });
  changePoints({ guildId: "e4", userId: "tie-a", amount: 50, reason: "x" });
  changePoints({ guildId: "e4", userId: "top", amount: 90, reason: "x", displayName: "Top Person" });
  assert.deepEqual(
    topByPoints("e4", 10, 0).map((row) => row.user_id),
    ["top", "tie-a", "tie-b", "low"],
  );
  assert.equal(topByPoints("e4", 1, 0)[0]?.display_name, "Top Person");
  assert.deepEqual(
    ["top", "tie-a", "tie-b", "low"].map((id) => pointsPosition("e4", id)),
    [1, 2, 3, 4],
  );
  assert.equal(countWithPoints("e4"), 4);
});
