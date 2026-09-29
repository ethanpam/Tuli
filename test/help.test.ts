import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplicationCommand } from "discord.js";
import { commandLines } from "../src/features/help.js";

const command = (fields: object) => fields as unknown as ApplicationCommand;

test("lists each subcommand as a clickable command", () => {
  const quote = command({
    name: "quote",
    id: "123",
    description: "Quotes",
    options: [
      { type: 1, name: "add", description: "Save something someone said" },
      { type: 1, name: "random", description: "Share a random quote" },
    ],
  });
  assert.deepEqual(commandLines(quote), [
    "</quote add:123> — Save something someone said",
    "</quote random:123> — Share a random quote",
  ]);
});

test("handles subcommand groups and plain commands", () => {
  const admin = command({
    name: "admin",
    id: "9",
    description: "Admin",
    options: [{ type: 2, name: "shop", description: "", options: [{ type: 1, name: "add", description: "Add an item" }] }],
  });
  assert.deepEqual(commandLines(admin), ["</admin shop add:9> — Add an item"]);
  assert.deepEqual(commandLines(command({ name: "rank", id: "7", description: "See your level", options: [] })), [
    "</rank:7> — See your level",
  ]);
});
