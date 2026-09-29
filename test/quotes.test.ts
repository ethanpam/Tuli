import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addQuote,
  countQuotes,
  deleteQuote,
  findDuplicateQuote,
  findQuoteByMessage,
  getQuote,
  latestAuthorName,
  listQuotes,
  randomQuote,
  type NewQuote,
} from "../src/features/quotes/store.js";

const base = { author_name: "Alex", added_by_id: "9", channel_id: null, message_id: null, created_at: 0 };
const quote = (fields: Partial<NewQuote> & Pick<NewQuote, "guild_id" | "text">): NewQuote => ({
  ...base,
  author_id: "1",
  ...fields,
});

test("quotes are numbered separately in each server", () => {
  assert.equal(addQuote(quote({ guild_id: "numbering-a", text: "one" })).number, 1);
  assert.equal(addQuote(quote({ guild_id: "numbering-a", text: "two" })).number, 2);
  assert.equal(addQuote(quote({ guild_id: "numbering-b", text: "one" })).number, 1);
});

test("duplicates ignore capitalization, spacing and quote marks, but only for the same person", () => {
  addQuote(quote({ guild_id: "dupes", text: "Hello  World" }));
  for (const text of ["hello world", "  HELLO WORLD ", '"Hello World"', "“hello   world”"]) {
    assert.ok(findDuplicateQuote("dupes", "1", text), text);
  }
  assert.equal(findDuplicateQuote("dupes", "2", "hello world"), undefined, "different person");
  assert.equal(findDuplicateQuote("other", "1", "hello world"), undefined, "different server");
  assert.equal(findDuplicateQuote("dupes", "1", "hello world!"), undefined, "different wording");
});

test("a message can only be saved once per server", () => {
  addQuote(quote({ guild_id: "msgs", text: "from a message", channel_id: "c", message_id: "m" }));
  assert.equal(findQuoteByMessage("msgs", "m")?.text, "from a message");
  assert.throws(() => addQuote(quote({ guild_id: "msgs", text: "again", channel_id: "c", message_id: "m" })), /UNIQUE/);
  addQuote(quote({ guild_id: "msgs", text: "typed in" }));
  addQuote(quote({ guild_id: "msgs", text: "also typed in" })); // quotes without a message don't collide
});

test("random, list and count can filter by person", () => {
  for (let i = 1; i <= 12; i++) addQuote(quote({ guild_id: "lists", text: `q${i}`, author_id: i % 3 ? "1" : "2" }));
  assert.equal(countQuotes("lists"), 12);
  assert.equal(countQuotes("lists", "2"), 4);
  assert.deepEqual(listQuotes("lists", undefined, 5, 10).map((q) => q.number), [11, 12]);
  for (let i = 0; i < 10; i++) assert.equal(randomQuote("lists", "2")?.author_id, "2");
  assert.equal(randomQuote("empty-server"), undefined);
});

test("latestAuthorName uses the name from the newest quote", () => {
  addQuote(quote({ guild_id: "names", text: "old", author_name: "Old Name" }));
  addQuote(quote({ guild_id: "names", text: "new", author_name: "New Name" }));
  assert.equal(latestAuthorName("names", "1"), "New Name");
});

test("deleting only affects the given server", () => {
  addQuote(quote({ guild_id: "del-a", text: "keep?" }));
  addQuote(quote({ guild_id: "del-b", text: "keep" }));
  deleteQuote("del-a", 1);
  assert.equal(getQuote("del-a", 1), undefined);
  assert.equal(getQuote("del-b", 1)?.text, "keep");
});
