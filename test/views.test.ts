// Renders each button/menu screen through its real handler with a stand-in interaction,
// then runs Discord's own validation on the result. Catches broken embeds and components
// that the type checker can't see.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changePoints, getBalance } from "../src/features/economy/store.js";
import { features } from "../src/features/index.js";
import { addQuote } from "../src/features/quotes/store.js";
import { questionMessage, resultsEmbed } from "../src/features/questions/index.js";
import { addQuestion, ANSWER_POINTS, claimNextQuestion } from "../src/features/questions/store.js";
import { addItem } from "../src/features/shop/store.js";
import { setLevel } from "../src/features/levels/store.js";
import type { ComponentHandler } from "../src/types.js";

const handlers = new Map<string, ComponentHandler>(
  features.flatMap((f) => f.components ?? []).map((h) => [h.prefix, h]),
);

const guild = { id: "view-guild", name: "Test Server", channels: { cache: new Map() }, roles: { cache: new Map() } };
const member = {
  id: "view-user",
  displayName: "Alex",
  guild,
  roles: { cache: new Map() },
  displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
};

type Payload = { embeds?: { toJSON(): unknown }[]; components?: { toJSON(): unknown }[] };

/** Clicks a button (or picks a menu value) and returns what the message was updated to. */
async function click(customId: string, values?: string[]): Promise<Payload> {
  const [prefix = "", ...args] = customId.split(":");
  let payload: Payload | undefined;
  const interaction = {
    guild,
    guildId: guild.id,
    member,
    user: member,
    values,
    client: { user: { id: "tuli" } },
    isStringSelectMenu: () => values !== undefined,
    update: async (p: Payload) => void (payload = p),
    reply: async (p: Payload) => void (payload = p),
  };
  await handlers.get(prefix)!.execute(interaction as never, args);
  assert.ok(payload, `${customId} responded`);
  for (const e of payload.embeds ?? []) e.toJSON(); // throws if invalid
  for (const row of payload.components ?? []) row.toJSON();
  return payload;
}

const json = (payload: Payload) => JSON.stringify(payload.embeds?.map((e) => e.toJSON()));

test("quote list pages render", async () => {
  for (let i = 1; i <= 12; i++)
    addQuote({
      guild_id: guild.id,
      text: `Quote ${i} ${"*".repeat(i)}`,
      author_id: "a",
      author_name: "Sam",
      added_by_id: "x",
      channel_id: null,
      message_id: null,
      created_at: Date.now(),
    });
  assert.match(json(await click("quote-list:1:")), /Page 2 of 2/);
});

test("leaderboards render, including when empty", async () => {
  assert.match(json(await click("leaderboard:0:points")), /Nobody's here yet/);
  setLevel(guild.id, "a", "Sam_the_*man*", 4);
  changePoints({ guildId: guild.id, userId: "a", amount: 500, reason: "Test" });
  assert.match(json(await click("leaderboard:0:levels")), /Level 4/);
  assert.match(json(await click("leaderboard:0:points")), /500/);
});

test("shop screens render: empty, storefront, item, purchase, orders", async () => {
  assert.match(json(await click("shop-page:0")), /empty/);

  const hint = addItem(guild.id, {
    name: "Trivia hint",
    description: "One hint at the next GBM",
    price: 100,
    roleId: null,
    stock: 3,
  });
  for (let i = 0; i < 9; i++)
    addItem(guild.id, { name: `Sticker ${i}`, description: "", price: 10 + i, roleId: null, stock: null });
  const storefront = await click("shop-page:0");
  assert.match(json(storefront), /Page 1 of 2/);
  assert.equal(storefront.components?.length, 2, "item menu and buttons");

  assert.match(json(await click("shop-pick:0", [String(hint.id)])), /You need/, "can't afford it yet");
  changePoints({ guildId: guild.id, userId: member.id, amount: 150, reason: "Test" });
  assert.match(json(await click("shop-pick:0", [String(hint.id)])), /Trivia hint/);

  assert.match(json(await click(`shop-buy:${hint.id}:0`)), /You bought/);
  assert.match(json(await click(`shop-buy:${hint.id}:0`)), /only have/, "second one is too expensive");
  assert.match(json(await click("shop-mine:0")), /Waiting for staff/);
});

test("question posts, answer buttons and results render", async () => {
  const trivia = addQuestion(guild.id, "Which is Iowa State's mascot?", "a", "queued", {
    kind: "choice",
    choices: ["Cy the Cardinal", "Herky the Hawk", "A very long answer ".repeat(5), "Goldy", "Sparky"],
    answer: 0,
  });
  const truefalse = addQuestion(guild.id, "Campanile has 50 bells.", "a", "queued", {
    kind: "truefalse",
    choices: ["True", "False"],
    answer: 0,
  });
  const poll = addQuestion(guild.id, "Tea or coffee?", "a", "queued", {
    kind: "choice",
    choices: ["Tea", "Coffee"],
    answer: null,
  });
  for (const question of [trivia, truefalse, poll, addQuestion(guild.id, "Open?", "a", "queued")]) {
    const message = questionMessage(claimNextQuestion(guild.id)!, "Question of the Day #1");
    message.embeds.forEach((e) => e.toJSON());
    message.components.forEach((row) => row.toJSON()); // e.g. button labels must be 80 characters or fewer
    assert.equal(message.components.length, question.kind === "open" ? 0 : 1);
    resultsEmbed(
      question,
      "Question of the Day #1",
      question.choices.map(() => 3),
      3,
    ).toJSON();
  }
  resultsEmbed(poll, "No votes", [0, 0], 0).toJSON();

  assert.match(json(await click(`question-answer:${trivia.id}:0`)), /Locked in/);
  assert.match(json(await click(`question-answer:${trivia.id}:1`)), /already picked \*\*A\. Cy the Cardinal/);
  assert.equal(getBalance(guild.id, member.id) >= 0, true);
  const before = getBalance(guild.id, member.id);
  assert.match(json(await click(`question-answer:${poll.id}:1`)), /You voted for \*\*B\. Coffee/);
  assert.equal(getBalance(guild.id, member.id), before + ANSWER_POINTS, "poll votes are paid right away");
  assert.match(json(await click(`question-answer:99999:0`)), /closed/);
});
