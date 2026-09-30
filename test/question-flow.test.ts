// End-to-end: runs the real router against a pretend Discord server, the way members and
// staff actually use button questions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getBalance } from "../src/features/economy/store.js";
import { features } from "../src/features/index.js";
import { addQuestion } from "../src/features/questions/store.js";
import { setSetting } from "../src/settings.js";
import { World, type Person } from "./support/fake-discord.js";

const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  name: id,
  color: "#fff",
  avatar: "",
  ...extra,
});

function setUp() {
  const world = new World(person("tuli", { bot: true }), "Test", features);
  const staff = world.addPerson(person("staff", { staff: true }));
  const alex = world.addPerson(person("alex"));
  const sam = world.addPerson(person("sam"));
  world.addChannel({ id: "qotd", name: "qotd" });
  world.addChannel({ id: "officers", name: "officers" });
  setSetting("guild", "questionChannelId", "qotd");
  setSetting("guild", "logChannelId", "officers");
  return { world, staff, alex, sam };
}

const lastReplyTo = (world: World, who: Person) => world.latest("qotd", (m) => m.visibleTo === who.id);
const text = (message: { content?: string; embeds: { description?: string }[] }) =>
  `${message.content ?? ""} ${message.embeds.map((e) => e.description ?? "").join(" ")}`;

test("trivia: post, answer, close, pay the right answers", async () => {
  const { world, staff, alex, sam } = setUp();
  const trivia = addQuestion("guild", "Iowa State's mascot?", "staff", "queued", {
    kind: "choice",
    choices: ["Herky", "Cy"],
    answer: 1,
  });
  await world.command(staff, "officers", "admin questions post-now");
  const post = world.latest("qotd", (m) => m.author.id === "tuli" && !m.ephemeral);
  assert.equal(post.components.length, 1, "the post has answer buttons");

  await world.click(alex, post, `question-answer:${trivia.id}:1`);
  assert.match(text(lastReplyTo(world, alex)), /Locked in/, "a freshly posted question accepts answers");
  await world.click(sam, post, `question-answer:${trivia.id}:0`);
  await world.click(alex, post, `question-answer:${trivia.id}:0`);
  assert.match(text(lastReplyTo(world, alex)), /already picked \*\*B\. Cy/, "answers can't be changed");
  assert.equal(getBalance("guild", "alex"), 0, "trivia pays only when the answer is revealed");

  await world.command(staff, "officers", "admin questions close");
  assert.equal(post.components.length, 0, "the buttons are gone");
  assert.match(text(post), /\*\*Cy\*\* ✅/, "the right answer is marked");
  assert.match(
    text(world.latest("qotd", (m) => m.replyTo === post.id)),
    /The answer was \*\*B\. Cy\*\*. 1 person got it right/,
  );
  assert.equal(getBalance("guild", "alex"), 10);
  assert.equal(getBalance("guild", "sam"), 0);

  await world.click(sam, post, `question-answer:${trivia.id}:1`);
  assert.match(text(lastReplyTo(world, sam)), /closed/, "late answers are turned away");
});

test("posting the next question closes the previous one but not itself", async () => {
  const { world, staff, alex } = setUp();
  const first = addQuestion("guild", "Tea or coffee?", "staff", "queued", {
    kind: "choice",
    choices: ["Tea", "Coffee"],
    answer: null,
  });
  const second = addQuestion("guild", "Cats or dogs?", "staff", "queued", {
    kind: "choice",
    choices: ["Cats", "Dogs"],
    answer: null,
  });
  await world.command(staff, "officers", "admin questions post-now");
  const firstPost = world.latest("qotd", (m) => m.author.id === "tuli" && !m.ephemeral);
  await world.click(alex, firstPost, `question-answer:${first.id}:1`);

  await world.command(staff, "officers", "admin questions post-now");
  assert.equal(firstPost.components.length, 0, "the first poll closed");
  assert.match(text(world.latest("qotd", (m) => m.replyTo === firstPost.id)), /\*\*B\. Coffee\*\* won/);

  const secondPost = world.latest("qotd", (m) => m.author.id === "tuli" && !m.ephemeral && !m.replyTo);
  await world.click(alex, secondPost, `question-answer:${second.id}:0`);
  assert.match(text(lastReplyTo(world, alex)), /You voted for \*\*A\. Cats/, "the new poll is open");
});
