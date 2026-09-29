import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplicationCommand } from "discord.js";
import { features } from "../src/features/index.js";
import { commandSections } from "../src/features/help.js";
import { createRouter } from "../src/router.js";

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
  assert.deepEqual(commandSections(quote), [
    {
      title: "/quote",
      lines: ["</quote add:123> — Save something someone said", "</quote random:123> — Share a random quote"],
    },
  ]);
});

test("gives each subcommand group its own section, and handles plain commands", () => {
  const admin = command({
    name: "admin",
    id: "9",
    description: "Admin",
    options: [
      { type: 2, name: "shop", description: "", options: [{ type: 1, name: "add", description: "Add an item" }] },
      { type: 2, name: "levels", description: "", options: [{ type: 1, name: "reward", description: "Add a reward" }] },
    ],
  });
  assert.deepEqual(commandSections(admin), [
    { title: "/admin shop", lines: ["</admin shop add:9> — Add an item"] },
    { title: "/admin levels", lines: ["</admin levels reward:9> — Add a reward"] },
  ]);
  assert.deepEqual(commandSections(command({ name: "rank", id: "7", description: "See your level", options: [] })), [
    { title: "/rank", lines: ["</rank:7> — See your level"] },
  ]);
});

test("the /tuli list fits in Discord's embed limits with every command", () => {
  const sections = createRouter(features)
    .commandData()
    .filter((data) => !("type" in data) || data.type === 1)
    .map((data) => ({
      data,
      sections: commandSections(
        command({ ...data, id: "1234567890123456789", options: "options" in data ? (data.options ?? []) : [] }),
      ),
    }));
  const everyone = sections
    .filter((s) => !s.data.default_member_permissions)
    .flatMap((s) => s.sections.flatMap((section) => section.lines));
  const staff = sections.filter((s) => s.data.default_member_permissions).flatMap((s) => s.sections);
  assert.ok(everyone.join("\n").length < 3900, "member commands fit in one embed description");
  assert.ok(staff.length <= 25, "one field per staff section, 25 max");
  for (const section of staff) assert.ok(section.lines.join("\n").length <= 1024, `${section.title} fits in a field`);
  const total =
    everyone.join("\n").length + staff.reduce((sum, s) => sum + s.title.length + s.lines.join("\n").length, 0);
  assert.ok(total < 5800, `both embeds together stay under Discord's 6000-character limit (${total})`);
});
