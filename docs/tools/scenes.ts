// The example server behind the README's pictures. Each scene runs Tuli's real commands the
// way people would use them, then freezes the channel so it can be drawn.
import { changePoints, claimDaily } from "../../src/features/economy/store.js";
import { fetchFeed, itemEmbed } from "../../src/features/feeds/index.js";
import { addFeed, recordCheck } from "../../src/features/feeds/store.js";
import type { FeedItem } from "../../src/features/feeds/parse.js";
import { features } from "../../src/features/index.js";
import { awardMessageXp, getLevel, setLevel, setReward, totalXpForLevel } from "../../src/features/levels/store.js";
import { addQuestion, TRUE_FALSE } from "../../src/features/questions/store.js";
import { addQuote } from "../../src/features/quotes/store.js";
import { addItem } from "../../src/features/shop/store.js";
import { DEFAULT_TIMEZONE, setSetting } from "../../src/settings.js";
import { localDate, previousDate } from "../../src/time.js";
import { initialAvatar } from "./brand.js";
import { freezeTime } from "./clock.js";
import type { Directory, Shot } from "./discord-html.js";
import { World, type ChatMessage, type Person } from "../../test/support/fake-discord.js";

export interface Animation {
  name: string;
  frames: { shot: Shot; delay: number }[];
}

const GUILD = "guild";

let nextId = 0;

/** An example member, with an 18-digit ID like a real Discord account. */
function person(name: string, color: string, extra: Partial<Person> = {}): Person {
  const id = `11824${String(++nextId).padStart(13, "0")}`;
  return { id, name, color: "#f2f3f5", avatar: initialAvatar(name, color), ...extra };
}

/** `tuliAvatar` is Tuli's profile picture (a small image URL) to show on its messages. */
export async function buildScenes(tuliAvatar: string) {
  // A Tuesday at 9:05 AM in Ames, just after the morning question goes out.
  const clock = freezeTime("2026-10-06T14:05:00Z");
  const tuli: Person = { id: "tuli", name: "Tuli", color: "#f2f3f5", avatar: tuliAvatar, bot: true };
  const world = new World(tuli, "ISU Community", features);

  const alex = world.addPerson(person("Alex", "#e67e22"));
  const sam = world.addPerson(person("Sam", "#16a085"));
  const jordan = world.addPerson(person("Jordan", "#8e44ad", { color: "#f1c40f", staff: true }));
  const riley = world.addPerson(person("Riley", "#c0392b", { newAccount: true }));
  const colors = ["#2980b9", "#27ae60", "#d35400", "#7f8c8d", "#c2185b", "#00897b", "#5e35b1", "#6d4c41", "#1565c0"];
  const crowd = ["Maya", "Chris", "Priya", "Ben", "Lena", "Omar", "Zoe", "Noah", "Ava"].map((name, i) =>
    world.addPerson(person(name, colors[i]!)),
  );
  const byName = (name: string) => [...world.people.values()].find((p) => p.name === name)!;

  world.addChannel({ id: "general", name: "general", topic: "Hang out, meet people, share memes" });
  world.addChannel({ id: "bot", name: "bot-commands", topic: "Talk to Tuli here" });
  world.addChannel({ id: "qotd", name: "question-of-the-day", topic: "A new question every morning at 9" });
  world.addChannel({ id: "news", name: "campus-news", topic: "News and opportunities from around ISU" });
  world.addChannel({ id: "staff-log", name: "staff-log", topic: "Tuli's alerts for officers" });
  world.addChannel({ id: "officers", name: "officers", topic: "Officers only" });
  world.addRole({ id: "officer", name: "Officer", color: "#f1c40f" });
  world.addRole({ id: "regular", name: "Regular", color: "#3ba55c" });
  world.addRole({ id: "qotd-ping", name: "QOTD", color: "#5b8def" });
  world.addRole({ id: "champ", name: "Trivia Champ", color: "#e67e22" });

  setSetting(GUILD, "logChannelId", "staff-log");
  setSetting(GUILD, "questionChannelId", "qotd");
  setSetting(GUILD, "questionSchedule", { frequency: "daily", weekday: 1, hour: 9 });
  setSetting(GUILD, "questionPingRoleId", "qotd-ping");
  setSetting(GUILD, "questionLastRunAt", Date.now());
  setReward(GUILD, 5, "regular");

  const shots: Record<string, Shot> = {};
  const animations: Animation[] = [];
  const shot = (channel: string, count: number, viewer = "", highlight?: string): Shot => ({
    channel,
    messages: world.snapshot(channel, { count, viewer }),
    highlight,
  });

  // ─── Saying hi ──────────────────────────────────────────────────────────────
  await world.say(alex, "general", `<@${tuli.id}> hi!`, { mentionsTuli: true });
  shots.greet = shot("general", 2);

  // ─── /tuli ──────────────────────────────────────────────────────────────────
  await world.command(alex, "bot", "tuli");
  shots.help = shot("bot", 1, alex.id);

  // ─── Quotes ─────────────────────────────────────────────────────────────────
  const said = [
    ["Sam", "if the dining hall has waffles I'm going to class, if not I'm not"],
    ["Maya", "the Campanile is just a very large alarm clock"],
    ["Chris", "my GPA and the temperature in Ames in January are the same number"],
    ["Priya", "I don't need sleep, I need answers"],
    ["Ben", "CyRide waits for no one"],
    ["Lena", "every group project has one person who says 'I'll do the slides'"],
    ["Omar", "it's not procrastinating if you're making a to-do list"],
    ["Zoe", "Parks Library 4th floor is a different dimension"],
  ] as const;
  for (const [name, text] of said) {
    addQuote({
      guild_id: GUILD,
      text,
      author_id: byName(name).id,
      author_name: name,
      added_by_id: jordan.id,
      channel_id: null,
      message_id: null,
      created_at: Date.now() - 86_400_000,
    });
  }
  const quoted = await world.say(sam, "general", "been awake for 30 hours but at least my code compiles");
  await world.contextMenu(alex, "Save as quote", quoted);
  shots.quote = shot("general", 2);
  await world.command(alex, "bot", "quote list");
  shots.quoteList = shot("bot", 1, alex.id);

  // ─── Points ─────────────────────────────────────────────────────────────────
  // Everyone else has been around a while.
  const levels = [12, 9, 7, 7, 6, 4, 3, 3, 2];
  crowd.forEach((member, i) => {
    setLevel(GUILD, member.id, member.name, levels[i]!);
    changePoints({
      guildId: GUILD,
      userId: member.id,
      amount: 1500 - i * 140,
      reason: "Activity",
      displayName: member.name,
    });
  });
  setLevel(GUILD, sam.id, "Sam", 8);
  const today = localDate(DEFAULT_TIMEZONE);
  let day = today;
  const earlier: string[] = [];
  for (let i = 0; i < 4; i++) earlier.unshift((day = previousDate(day)));
  for (const date of earlier.slice(1)) claimDaily(GUILD, alex.id, "Alex", date, previousDate(date));
  changePoints({ guildId: GUILD, userId: alex.id, amount: 420, reason: "GBM attendance", displayName: "Alex" });
  await world.command(alex, "bot", "points daily");
  await world.command(alex, "bot", "points balance");
  shots.points = shot("bot", 2, alex.id);

  // ─── Levels ─────────────────────────────────────────────────────────────────
  clock.advance(3 * 60_000);
  // Put Alex a few XP short of level 5, then have them chat.
  const shortOfLevel5 = totalXpForLevel(5) - 12 - getLevel(GUILD, alex.id).xp;
  awardMessageXp(GUILD, alex.id, "Alex", Date.now() - 120_000, () => shortOfLevel5);
  await world.say(alex, "general", "anyone want to study for the calc exam tonight? 📚");
  shots.levelUp = shot("general", 2);
  await world.command(alex, "bot", "rank");
  shots.rank = shot("bot", 1, alex.id);
  await world.command(sam, "bot", "leaderboard");
  shots.leaderboard = shot("bot", 1);

  // ─── Shop ───────────────────────────────────────────────────────────────────
  const hint = addItem(GUILD, {
    name: "Trivia hint",
    description: "One hint during the next GBM trivia round",
    price: 150,
    roleId: null,
    stock: null,
  });
  addItem(GUILD, {
    name: "Trivia Champ role",
    description: "Show off in the member list",
    price: 500,
    roleId: "champ",
    stock: null,
  });
  addItem(GUILD, {
    name: "ISU sticker pack",
    description: "Picked up at the next meeting",
    price: 250,
    roleId: null,
    stock: 12,
  });
  addItem(GUILD, {
    name: "Pick the next GBM snack",
    description: "Your call. Choose wisely",
    price: 800,
    roleId: null,
    stock: 1,
  });
  await world.command(alex, "bot", "shop");
  const storefront = world.latest("bot", (m) => m.visibleTo === alex.id);
  const shopFrames: Animation["frames"] = [{ shot: shot("bot", 1, alex.id, "shop-pick:0"), delay: 2200 }];
  await world.click(alex, storefront, "shop-pick:0", [String(hint.id)]);
  shopFrames.push(
    { shot: shot("bot", 1, alex.id), delay: 1200 },
    { shot: shot("bot", 1, alex.id, `shop-buy:${hint.id}:0`), delay: 1000 },
  );
  await world.click(alex, storefront, `shop-buy:${hint.id}:0`);
  shopFrames.push({ shot: shot("bot", 1, alex.id), delay: 3200 });
  animations.push({ name: "shop", frames: shopFrames });
  shots.shopOrder = shot("staff-log", 1);

  // ─── Questions ──────────────────────────────────────────────────────────────
  addQuestion(GUILD, "What's your go-to study spot on campus, and why?", jordan.id, "queued");
  await world.command(jordan, "officers", "admin questions post-now");
  const open = world.latest("qotd");
  const answers = [
    [sam, "Parks Library 4th floor. Silent, outlets everywhere"],
    [crowd[0]!, "the Hub, for the coffee"],
    [alex, "Howe Hall atrium when it's raining"],
  ] as const;
  for (const [who, text] of answers) await world.say(who, `thread-${open.id}`, text);
  shots.questionOpen = shot("qotd", 1);

  const trivia = addQuestion(GUILD, "What is the name of Iowa State's mascot?", jordan.id, "queued", {
    kind: "choice",
    choices: ["Herky", "Cy", "Goldy", "Sparky"],
    answer: 1,
  });
  await world.command(jordan, "officers", "admin questions post-now");
  const post = world.latest("qotd");
  const triviaFrames: Animation["frames"] = [{ shot: shot("qotd", 1, alex.id), delay: 2200 }];
  const votes = [1, 1, 0, 1, 3, 1, 1, 2, 1];
  for (const [i, member] of crowd.entries())
    await world.click(member, post, `question-answer:${trivia.id}:${votes[i]}`);
  await world.click(sam, post, `question-answer:${trivia.id}:1`);
  triviaFrames.push({ shot: shot("qotd", 1, alex.id, `question-answer:${trivia.id}:1`), delay: 1000 });
  await world.click(alex, post, `question-answer:${trivia.id}:1`);
  triviaFrames.push({ shot: shot("qotd", 2, alex.id), delay: 2600 });
  await world.command(jordan, "officers", "admin questions close");
  triviaFrames.push({ shot: shot("qotd", 3, alex.id), delay: 4200 });
  animations.push({ name: "trivia", frames: triviaFrames });
  shots.triviaResults = shot("qotd", 2);

  addQuestion(GUILD, "The Campanile has 50 bells.", jordan.id, "queued", {
    kind: "truefalse",
    choices: TRUE_FALSE,
    answer: 0,
  });
  await world.command(jordan, "officers", "admin questions post-now");
  shots.trueFalse = shot("qotd", 1);

  // ─── Scam protection ────────────────────────────────────────────────────────
  clock.advance(47 * 60_000);
  await world.say(sam, "general", "does anyone have notes from Tuesday's lecture?");
  await world.say(crowd[1]!, "general", "yeah I'll send them after class");
  const scamFrames: Animation["frames"] = [{ shot: shot("general", 2), delay: 1600 }];
  const scam = world.post("general", riley, {
    content:
      "@everyone Free Discord Nitro for everyone 🎁 claim it before it's gone → https://dlscord.gift/nitro-claim",
  });
  scamFrames.push({ shot: shot("general", 3), delay: 2400 });
  await world.deliver(scam);
  scamFrames.push({ shot: shot("general", 2), delay: 1400 }, { shot: shot("staff-log", 1), delay: 4200 });
  animations.push({ name: "scam", frames: scamFrames });
  shots.scam = shot("staff-log", 1);
  shots.scamDm = shot("dm-riley", 1);

  // ─── Feeds ──────────────────────────────────────────────────────────────────
  const feedUrl = "https://www.news.iastate.edu/rss.xml";
  let items: FeedItem[];
  let feedTitle = "ISU News Service";
  try {
    const feed = await fetchFeed(feedUrl);
    feedTitle = feed.title;
    items = [...feed.items]
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
      .slice(0, 2)
      .reverse();
  } catch {
    items = [];
  }
  if (items.length === 0) {
    items = [
      {
        key: "1",
        title: "Fall career fair connects students with employers",
        link: "https://www.news.iastate.edu/",
        summary: "Students can meet recruiters for internships and full-time jobs.",
        publishedAt: Date.now() - 3_600_000,
        imageUrl: null,
      },
    ];
  }
  for (const item of items) world.post("news", tuli, { embeds: [itemEmbed({ title: feedTitle, url: feedUrl }, item)] });
  shots.feed = shot("news", 2);

  // ─── Setup ──────────────────────────────────────────────────────────────────
  // A healthy server: questions lined up and the news feed followed.
  for (const text of [
    "What's a class everyone should take before graduating?",
    "Best late-night food in Ames?",
    "What club should more people know about?",
  ]) {
    addQuestion(GUILD, text, jordan.id, "queued");
  }
  const feed = addFeed(GUILD, { channelId: "news", url: feedUrl, title: feedTitle, keywords: "" });
  recordCheck(feed.id, null);
  await world.command(jordan, "officers", "admin setup overview");
  shots.setup = shot("officers", 1, jordan.id);

  const directory: Directory = {
    people: world.people,
    roles: world.roles,
    channels: world.channels,
    messages: world.messages,
    timezone: DEFAULT_TIMEZONE,
  };
  return { shots, animations, directory };
}

export type { ChatMessage };
