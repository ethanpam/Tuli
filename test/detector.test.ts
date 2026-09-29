import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkMessage,
  isLookalikeDomain,
  linkDomains,
  RepeatTracker,
  repeatKey,
} from "../src/features/moderation/detector.js";

const check = (content: string, canMentionEveryone = false) => checkMessage({ content, canMentionEveryone });

test("finds link domains", () => {
  assert.deepEqual(linkDomains("go to https://www.Discord.com/app and http://evil.ru:8080/x"), [
    "discord.com",
    "evil.ru",
  ]);
});

test("spots fake Discord and Steam domains but not the real ones", () => {
  for (const fake of [
    "dlscord.gift",
    "disc0rd-nitro.com",
    "discorcl.com",
    "discord-gifts.ru",
    "steamcommunlty.com",
    "stearncommunity.ru",
    "discordnitro.click",
  ]) {
    assert.ok(isLookalikeDomain(fake), fake);
  }
  for (const real of [
    "discord.com",
    "discord.gg",
    "cdn.discordapp.com",
    "media.discordapp.net",
    "steamcommunity.com",
    "store.steampowered.com",
    "github.com",
    "iastate.edu",
    "youtube.com",
    "docs.google.com",
  ]) {
    assert.ok(!isLookalikeDomain(real), real);
  }
});

test("blocks the usual scams", () => {
  assert.equal(check("Free nitro for everyone! https://dlscord.gift/abc")?.action, "block");
  assert.equal(check("Steam is giving a free gift card https://example.com/claim")?.action, "block");
  assert.equal(check("@everyone check this out https://example.com")?.action, "block");
});

test("lets normal messages through", () => {
  for (const ok of [
    "Anyone want to study for the calc exam? https://docs.google.com/document/d/123",
    "join our server https://discord.gg/abcdef",
    "I got nitro for my birthday lol",
    "@everyone meeting at 6 in Howe Hall", // no link
    "selling my soul for a good grade",
  ]) {
    assert.equal(check(ok), null, ok);
  }
  assert.equal(check("@everyone slides are up https://docs.google.com/x", true), null, "mods can ping everyone");
});

test("flags giveaway bait for staff to review", () => {
  const verdict = check("Giving away my MacBook Pro 2022 for free, DM me if interested!");
  assert.equal(verdict?.action, "flag");
  assert.equal(check("selling 2 tickets to the game, text me")?.action, "flag");
  assert.equal(check("I'm selling my textbook"), null);
});

test("repeat tracker catches the same message in three channels within a minute", () => {
  const tracker = new RepeatTracker(60_000, 3);
  const post = (channelId: string, at: number, key = "text:buy crypto now") =>
    tracker.record("g", "u", { channelId, messageId: `${channelId}-${at}`, key, at });

  assert.equal(post("a", 0), null);
  assert.equal(post("a", 1_000), null, "same channel twice isn't a burst");
  assert.equal(post("b", 2_000), null);
  const burst = post("c", 3_000);
  assert.deepEqual(
    burst?.map((m) => m.channelId),
    ["a", "a", "b", "c"],
    "every copy is returned so all can be deleted",
  );
  assert.equal(post("d", 4_000), null, "each burst is reported once");

  const slow = new RepeatTracker(60_000, 3);
  slow.record("g", "u", { channelId: "a", messageId: "1", key: "text:hello there", at: 0 });
  slow.record("g", "u", { channelId: "b", messageId: "2", key: "text:hello there", at: 70_000 });
  assert.equal(
    slow.record("g", "u", { channelId: "c", messageId: "3", key: "text:hello there", at: 80_000 }),
    null,
    "old copies expire",
  );
});

test("repeat keys ignore short chatter", () => {
  assert.equal(repeatKey("lol", []), null);
  assert.equal(repeatKey("Hello   Everyone!!", []), "text:hello everyone!!");
  assert.equal(repeatKey("", ["b.png:10", "a.png:5"]), "files:a.png:5|b.png:10");
});
