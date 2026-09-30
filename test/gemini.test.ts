import assert from "node:assert/strict";
import { test } from "node:test";
import { converse, GeminiError, type Tools } from "../src/features/chat/gemini.js";
import { fakeGemini } from "./support/fake-gemini.js";

const config = { apiKey: "test-key", model: "gemini-test" };
const hello = [{ role: "user" as const, parts: [{ text: "Alex: hi" }] }];

test("a plain reply comes back as text, with thoughts left out", async () => {
  const gemini = fakeGemini([{ text: "thinking...", thought: true }, { text: "hey alex!" }]);
  try {
    assert.equal(await converse(config, "You're Tuli.", hello), "hey alex!");
    assert.equal(gemini.requests[0]?.systemInstruction.parts[0]?.text, "You're Tuli.");
  } finally {
    gemini.restore();
  }
});

test("tool calls run, and the model's turn goes back unchanged (thought signature included)", async () => {
  const gemini = fakeGemini(
    [{ functionCall: { name: "check_my_points", args: {}, id: "call-1" }, thoughtSignature: "sig-abc" }],
    [{ text: "you've got 120 points!" }],
  );
  const calls: string[] = [];
  const tools: Tools = {
    declarations: [{ name: "check_my_points", description: "Points" }],
    run: async (name) => (calls.push(name), { points: 120 }),
  };
  try {
    assert.equal(await converse(config, "system", hello, tools), "you've got 120 points!");
    assert.deepEqual(calls, ["check_my_points"]);
    const second = gemini.requests[1]!;
    assert.deepEqual(second.contents[1], {
      role: "model",
      parts: [{ functionCall: { name: "check_my_points", args: {}, id: "call-1" }, thoughtSignature: "sig-abc" }],
    });
    assert.deepEqual(second.contents[2], {
      role: "user",
      parts: [{ functionResponse: { name: "check_my_points", response: { points: 120 }, id: "call-1" } }],
    });
    assert.equal(gemini.requests[0]?.tools?.[0]?.functionDeclarations[0]?.name, "check_my_points");
  } finally {
    gemini.restore();
  }
});

test("a tool that throws reports the error to the model instead of crashing", async () => {
  const gemini = fakeGemini([{ functionCall: { name: "broken", args: {} } }], [{ text: "oops, couldn't check" }]);
  const tools: Tools = { declarations: [], run: async () => Promise.reject(new Error("database is sad")) };
  try {
    assert.equal(await converse(config, "system", hello, tools), "oops, couldn't check");
    assert.deepEqual(gemini.requests[1]?.contents[2]?.parts[0]?.functionResponse?.response, {
      error: "database is sad",
    });
  } finally {
    gemini.restore();
  }
});

test("API errors become friendly kinds", async () => {
  const cases = [
    [429, "Resource exhausted", "rate-limit"],
    [400, "API key not valid", "auth"],
    [403, "Permission denied", "auth"],
    [503, "Overloaded", "unavailable"],
    [400, "Something else", "other"],
  ] as const;
  for (const [status, message, kind] of cases) {
    const gemini = fakeGemini({ status, message });
    try {
      await assert.rejects(
        converse(config, "system", hello),
        (error: unknown) => error instanceof GeminiError && error.kind === kind,
      );
    } finally {
      gemini.restore();
    }
  }
});

test("a model that keeps calling tools is stopped", async () => {
  const gemini = fakeGemini([{ functionCall: { name: "loop", args: {} } }]);
  const tools: Tools = { declarations: [], run: async () => ({ ok: true }) };
  try {
    await assert.rejects(converse(config, "system", hello, tools), /Too many tool calls/);
  } finally {
    gemini.restore();
  }
});
