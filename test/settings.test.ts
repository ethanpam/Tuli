import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIMEZONE, getSetting, getTimezone, guildsWithSetting, setSetting } from "../src/settings.js";

test("settings are saved per server and can be cleared", () => {
  assert.equal(getSetting("s1", "logChannelId"), undefined);
  setSetting("s1", "logChannelId", "123");
  setSetting("s1", "logChannelId", "456");
  setSetting("s2", "logChannelId", "789");
  assert.equal(getSetting("s1", "logChannelId"), "456");
  assert.deepEqual(guildsWithSetting("logChannelId").map((row) => row.guildId).sort(), ["s1", "s2"]);
  setSetting("s1", "logChannelId", undefined);
  assert.equal(getSetting("s1", "logChannelId"), undefined);
});

test("timezone falls back to the default", () => {
  assert.equal(getTimezone("unset"), DEFAULT_TIMEZONE);
  setSetting("tz", "timezone", "Asia/Tokyo");
  assert.equal(getTimezone("tz"), "Asia/Tokyo");
});
