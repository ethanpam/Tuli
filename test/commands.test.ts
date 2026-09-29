import assert from "node:assert/strict";
import { test } from "node:test";
import { features } from "../src/features/index.js";
import { createRouter } from "../src/router.js";

// Discord rejects a command whose names, descriptions and choices add up to more than 8000 characters.
function discordSize(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + discordSize(item), 0);
  if (!value || typeof value !== "object") return 0;
  let size = 0;
  for (const [key, field] of Object.entries(value)) {
    if ((key === "name" || key === "description" || key === "value") && typeof field === "string") size += field.length;
    else size += discordSize(field);
  }
  return size;
}

test("every command is valid and within Discord's size limit", () => {
  const commands = createRouter(features).commandData(); // builders throw on invalid names/descriptions
  const names = commands.map((command) => command.name);
  assert.equal(new Set(names).size, names.length, "command names are unique");
  for (const command of commands) {
    assert.ok(discordSize(command) <= 8000, `/${command.name} is ${discordSize(command)} characters`);
  }
});

test("component prefixes are unique", () => {
  const prefixes = features.flatMap((feature) => feature.components ?? []).map((handler) => handler.prefix);
  assert.equal(new Set(prefixes).size, prefixes.length);
});
