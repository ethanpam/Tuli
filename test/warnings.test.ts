import assert from "node:assert/strict";
import { test } from "node:test";
import { addWarning, deleteWarning, listWarnings } from "../src/features/moderation/store.js";

test("warnings are listed newest first and can be removed, per server", () => {
  const first = addWarning("w1", "alex", "mod", "Spamming");
  addWarning("w1", "alex", "mod", "Rude in #general");
  addWarning("w2", "alex", "mod", "Other server");
  assert.deepEqual(
    listWarnings("w1", "alex").map((w) => w.reason),
    ["Rude in #general", "Spamming"],
  );
  assert.equal(deleteWarning("w2", first.id), undefined, "can't delete another server's warning");
  assert.equal(deleteWarning("w1", first.id)?.reason, "Spamming");
  assert.equal(listWarnings("w1", "alex").length, 1);
});
