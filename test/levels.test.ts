import assert from "node:assert/strict";
import { test } from "node:test";
import { getBalance, recentTransactions } from "../src/features/economy/store.js";
import {
  awardMessageXp,
  getLevel,
  levelProgress,
  levelUpPoints,
  listRewards,
  membersAtLevel,
  removeReward,
  setLevel,
  setReward,
  topByXp,
  totalXpForLevel,
  XP_COOLDOWN_MS,
  xpPosition,
  xpToNextLevel,
} from "../src/features/levels/store.js";

test("the XP curve", () => {
  assert.deepEqual([0, 1, 2, 3].map(xpToNextLevel), [100, 155, 220, 295]);
  assert.equal(totalXpForLevel(3), 475);
  assert.deepEqual(levelProgress(0), { level: 0, xpIntoLevel: 0, xpForNextLevel: 100 });
  assert.deepEqual(levelProgress(99), { level: 0, xpIntoLevel: 99, xpForNextLevel: 100 });
  assert.deepEqual(levelProgress(100), { level: 1, xpIntoLevel: 0, xpForNextLevel: 155 });
  assert.deepEqual(levelProgress(totalXpForLevel(10) + 5).level, 10);
});

test("XP is awarded at most once a minute, but every message is counted", () => {
  const roll = () => 20;
  const t0 = 1_000_000;
  assert.equal(awardMessageXp("l1", "a", "Alex", t0, roll).awarded, true);
  assert.equal(awardMessageXp("l1", "a", "Alex", t0 + XP_COOLDOWN_MS - 1, roll).awarded, false);
  assert.equal(awardMessageXp("l1", "a", "Alex", t0 + XP_COOLDOWN_MS, roll).awarded, true);
  assert.deepEqual(
    { xp: getLevel("l1", "a").xp, messages: getLevel("l1", "a").message_count },
    { xp: 40, messages: 3 },
  );
});

test("leveling up gives bonus points for every level reached", () => {
  // 90 XP, then +25 crosses into level 1.
  const t0 = 1_000_000;
  awardMessageXp("l2", "a", "Alex", t0, () => 90);
  const result = awardMessageXp("l2", "a", "Alex", t0 + XP_COOLDOWN_MS, () => 25);
  assert.deepEqual(result, {
    awarded: true,
    gained: 25,
    xp: 115,
    level: 1,
    previousLevel: 0,
    bonusPoints: levelUpPoints(1),
  });
  assert.equal(getBalance("l2", "a"), 20);

  // A big jump from level 1 to 3 pays for levels 2 and 3.
  const jump = awardMessageXp("l2", "a", "Alex", t0 + 2 * XP_COOLDOWN_MS, () => 400);
  assert.ok(jump.awarded && jump.level === 3);
  assert.equal(getBalance("l2", "a"), 20 + levelUpPoints(2) + levelUpPoints(3));
  assert.equal(recentTransactions("l2", "a", 1)[0]?.reason, "Reached level 3");
});

test("staff can set a level, and rankings follow XP", () => {
  setLevel("l3", "a", "Alex", 5);
  setLevel("l3", "b", "Sam", 2);
  assert.deepEqual(getLevel("l3", "a").level, 5);
  assert.equal(getLevel("l3", "a").xp, totalXpForLevel(5));
  assert.deepEqual(
    topByXp("l3", 10, 0).map((row) => row.user_id),
    ["a", "b"],
  );
  assert.equal(xpPosition("l3", "b"), 2);
  assert.deepEqual(membersAtLevel("l3", 3), ["a"]);
  assert.equal(getBalance("l3", "a"), 0, "setting a level doesn't pay out points");
});

test("reward roles can be added, moved to another level, and removed", () => {
  setReward("l4", 10, "role-a");
  setReward("l4", 5, "role-b");
  setReward("l4", 20, "role-a"); // same role, new level
  assert.deepEqual(
    listRewards("l4").map((reward) => ({ ...reward })),
    [
      { level: 5, role_id: "role-b" },
      { level: 20, role_id: "role-a" },
    ],
  );
  assert.equal(removeReward("l4", "role-b"), true);
  assert.equal(removeReward("l4", "role-b"), false);
});
