// Stands in for Google's Gemini API in tests: records each request and answers with scripted replies.
import type { Part } from "../../src/features/chat/gemini.js";

export interface GeminiRequest {
  systemInstruction: { parts: { text: string }[] };
  contents: { role: string; parts: Part[] }[];
  tools?: { functionDeclarations: { name: string }[] }[];
}

type Answer = Part[] | { status: number; message: string };

/** Replaces fetch for Gemini calls. Each call takes the next scripted answer (the last one repeats). */
export function fakeGemini(...answers: Answer[]) {
  const requests: GeminiRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (!String(url).includes("generativelanguage.googleapis.com")) return realFetch(url, init);
    requests.push(JSON.parse(String(init?.body)));
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)]!;
    if (!Array.isArray(answer)) {
      return new Response(JSON.stringify({ error: { message: answer.message } }), { status: answer.status });
    }
    return new Response(
      JSON.stringify({ candidates: [{ content: { role: "model", parts: answer }, finishReason: "STOP" }] }),
    );
  }) as typeof fetch;
  return {
    requests,
    restore: () => void (globalThis.fetch = realFetch),
  };
}
