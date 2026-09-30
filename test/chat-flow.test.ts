// End-to-end: members chatting with Tuli, with Gemini's side played by a fake.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { chatsSettled } from "../src/features/chat/index.js";
import { getBalance } from "../src/features/economy/store.js";
import { addEvent } from "../src/features/events/store.js";
import { features } from "../src/features/index.js";
import { getSetting, setSetting } from "../src/settings.js";
import { fakeGemini } from "./support/fake-gemini.js";
import { World, type Person } from "./support/fake-discord.js";

const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
  id,
  name,
  color: "#fff",
  avatar: "",
  ...extra,
});

let guildCount = 0;
beforeEach(() => void (process.env.GEMINI_API_KEY = "test-key"));
afterEach(() => void delete process.env.GEMINI_API_KEY);

/** A fresh server (each test gets its own, since cooldowns and settings are per server). */
function setUp() {
  const world = new World(person("tuli", "Tuli", { bot: true }), "ASU Discord", features);
  const guildId = world.guild.id + ++guildCount;
  world.guild.id = guildId;
  const alex = world.addPerson(person("alex", "Alex"));
  const sam = world.addPerson(person("sam", "Sam"));
  const staff = world.addPerson(person("staff", "Jordan", { staff: true }));
  world.addChannel({ id: "general", name: "general" });
  world.addChannel({ id: "chat", name: "chat-with-tuli" });
  setSetting(guildId, "aiEnabled", true);
  return { world, guildId, alex, sam, staff };
}

async function say(world: World, ...args: Parameters<World["say"]>) {
  const message = await world.say(...args);
  await chatsSettled();
  return message;
}

const tuliReplies = (world: World, channel = "general") =>
  world.messages.filter((m) => m.channelId === channel && m.author.id === "tuli").map((m) => m.content);

test("mention Tuli with a question and it answers in character, knowing about the server", async () => {
  const { world, guildId, alex } = setUp();
  setSetting(guildId, "aiAbout", "ASU is the Asian Student Union at Iowa State.");
  addEvent(guildId, {
    title: "GBM #3",
    starts_at: Date.now() + 86_400_000,
    location: "MU Great Hall",
    description: "",
    link: "",
    created_by: "staff",
  });
  const gemini = fakeGemini([{ text: "Tuli: omg hi alex! next GBM is tomorrow in the MU 🐰" }]);
  try {
    await say(world, alex, "general", "<@tuli> when's the next gbm?");
    assert.deepEqual(
      tuliReplies(world),
      ["omg hi alex! next GBM is tomorrow in the MU 🐰"],
      "no 'Tuli:' prefix, no greeting too",
    );

    const request = gemini.requests[0]!;
    const system = request.systemInstruction.parts[0]!.text;
    assert.match(system, /ASU is the Asian Student Union at Iowa State/);
    assert.match(system, /GBM #3 · .* · MU Great Hall/);
    assert.match(system, /You're talking to|Who you're talking to\nAlex/);
    assert.match(system, /be honest: you're Tuli, the server's bot/);
    assert.deepEqual(request.contents, [{ role: "user", parts: [{ text: "Alex: when's the next gbm?" }] }]);
  } finally {
    gemini.restore();
  }
});

test("replying to Tuli keeps the conversation going, with what was said before", async (t) => {
  const { world, alex } = setUp();
  const gemini = fakeGemini([{ text: "seasons, no contest" }], [{ text: "the waffles, obviously" }]);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    await say(world, alex, "general", "<@tuli> best dining hall?");
    const tuliMessage = world.latest("general", (m) => m.author.id === "tuli");
    t.mock.timers.tick(10_000); // past the cooldown
    await say(world, alex, "general", "why?", { replyTo: tuliMessage });
    assert.deepEqual(gemini.requests[1]?.contents, [
      { role: "user", parts: [{ text: "Alex: best dining hall?" }] },
      { role: "model", parts: [{ text: "seasons, no contest" }] },
      { role: "user", parts: [{ text: "Alex: why?" }] },
    ]);
    assert.equal(tuliReplies(world).at(-1), "the waffles, obviously");
  } finally {
    gemini.restore();
  }
});

test("Tuli uses its tools to do things for the person talking", async () => {
  const { world, guildId, alex } = setUp();
  const gemini = fakeGemini(
    [{ functionCall: { name: "claim_daily_points", args: {} } }],
    [{ text: "done! +50 for you" }],
  );
  try {
    await say(world, alex, "general", "<@tuli> can you claim my daily for me?");
    assert.equal(getBalance(guildId, "alex"), 50, "the daily reward really was claimed, for Alex");
    const result = gemini.requests[1]?.contents.at(-1)?.parts[0]?.functionResponse?.response;
    assert.equal(result?.claimed, true);
    assert.equal(tuliReplies(world).at(-1), "done! +50 for you");
  } finally {
    gemini.restore();
  }
});

test("a bare mention still gets a hello, and replies to Tuli's posts aren't chat", async () => {
  const { world, alex } = setUp();
  const gemini = fakeGemini([{ text: "should not be used" }]);
  try {
    await say(world, alex, "general", "<@tuli>");
    assert.match(tuliReplies(world)[0] ?? "", /Alex! 👋 Ask me anything/);
    const post = world.post("general", world.tuli, { embeds: [{ title: "Question of the Day #1" }] });
    await say(world, alex, "general", "my answer is pizza", { replyTo: post });
    assert.equal(gemini.requests.length, 0);
  } finally {
    gemini.restore();
  }
});

test("chat can be limited to one channel, and is off without a key or when disabled", async () => {
  const { world, guildId, alex } = setUp();
  const gemini = fakeGemini([{ text: "hey!" }]);
  try {
    setSetting(guildId, "aiChannelId", "chat");
    await say(world, alex, "general", "<@tuli> hi there");
    assert.match(tuliReplies(world)[0] ?? "", /come find me in <#chat>/);
    await say(world, alex, "chat", "<@tuli> hi there");
    assert.deepEqual(tuliReplies(world, "chat"), ["hey!"]);

    setSetting(guildId, "aiEnabled", false);
    await say(world, alex, "chat", "<@tuli> you there?");
    assert.match(tuliReplies(world, "chat").at(-1) ?? "", /👋/, "just a greeting when chat is off");
    assert.equal(gemini.requests.length, 1);
  } finally {
    gemini.restore();
  }
});

test("people can't flood Tuli: a quick second message gets a ⏳ instead", async () => {
  const { world, alex, sam } = setUp();
  const gemini = fakeGemini([{ text: "hi" }]);
  try {
    await say(world, alex, "general", "<@tuli> one");
    const second = await say(world, alex, "general", "<@tuli> two");
    assert.deepEqual(second.reactions, ["⏳"]);
    await say(world, sam, "general", "<@tuli> three");
    assert.equal(gemini.requests.length, 2, "the cooldown is per person");
  } finally {
    gemini.restore();
  }
});

test("when Gemini is busy, Tuli says so like a person instead of erroring", async () => {
  const { world, alex } = setUp();
  const gemini = fakeGemini({ status: 429, message: "Resource exhausted" });
  const logError = console.error;
  console.error = () => {};
  try {
    await say(world, alex, "general", "<@tuli> hello?");
    assert.match(tuliReplies(world)[0] ?? "", /too many people talking to me/);
  } finally {
    console.error = logError;
    gemini.restore();
  }
});

test("staff set what Tuli knows and its personality with pop-up forms", async () => {
  const { world, guildId, staff } = setUp();
  await world.command(staff, "general", "admin ai about");
  assert.equal((world.modals.at(-1) as { custom_id: string }).custom_id, "ai-about");
  await world.submitModal(staff, "general", "ai-about", { text: "  ASU meets every other Thursday.  " });
  assert.equal(getSetting(guildId, "aiAbout"), "ASU meets every other Thursday.");

  await world.submitModal(staff, "general", "ai-personality", { text: "You're a grumpy bunny." });
  assert.equal(getSetting(guildId, "aiPersonality"), "You're a grumpy bunny.");
  await world.submitModal(staff, "general", "ai-personality", { text: "" });
  assert.equal(getSetting(guildId, "aiPersonality"), undefined, "an empty form goes back to the default");
});
