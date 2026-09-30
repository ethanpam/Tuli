// A small client for Google's Gemini API (generateContent), with function calling.
// https://ai.google.dev/api/generate-content

const API = "https://generativelanguage.googleapis.com/v1beta";

/** Fast, and on Gemini's free tier. Override with GEMINI_MODEL in .env (e.g. gemini-3.8-flash). */
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";

export interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  // Gemini also attaches metadata such as thought signatures, which must be sent back unchanged.
  [key: string]: unknown;
}

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface Tools {
  declarations: FunctionDeclaration[];
  run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export type GeminiErrorKind = "rate-limit" | "auth" | "blocked" | "unavailable" | "other";

export class GeminiError extends Error {
  constructor(
    readonly kind: GeminiErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
}

/** Reads GEMINI_API_KEY (and optionally GEMINI_MODEL) from the environment. */
export function geminiConfig(): GeminiConfig | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  return apiKey ? { apiKey, model: process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL } : null;
}

function errorKind(status: number, message: string): GeminiErrorKind {
  if (status === 429) return "rate-limit";
  if (status === 401 || status === 403 || /api key/i.test(message)) return "auth";
  if (status >= 500) return "unavailable";
  return "other";
}

/** One call to the model. Returns the model's turn exactly as sent, so it can go back into the history. */
export async function generate(
  config: GeminiConfig,
  request: { system: string; contents: Content[]; tools?: FunctionDeclaration[] },
): Promise<Content> {
  let response: Response;
  try {
    response = await fetch(`${API}/models/${encodeURIComponent(config.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: request.contents,
        ...(request.tools?.length ? { tools: [{ functionDeclarations: request.tools }] } : {}),
        generationConfig: { maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new GeminiError("unavailable", `Couldn't reach Gemini: ${error instanceof Error ? error.message : error}`);
  }

  const data = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
    candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  };
  if (!response.ok) {
    const message = data.error?.message ?? `HTTP ${response.status}`;
    throw new GeminiError(errorKind(response.status, message), message);
  }
  if (data.promptFeedback?.blockReason) throw new GeminiError("blocked", `Blocked: ${data.promptFeedback.blockReason}`);
  const [candidate] = data.candidates ?? [];
  const parts = candidate?.content?.parts ?? [];
  if (parts.length === 0) {
    const reason = candidate?.finishReason ?? "no reply";
    throw new GeminiError(
      /SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(reason) ? "blocked" : "other",
      `Empty reply (${reason})`,
    );
  }
  return { role: "model", parts };
}

function replyText(content: Content): string {
  return content.parts
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("")
    .trim();
}

const MAX_TOOL_ROUNDS = 4;

/**
 * Has a conversation turn: lets the model call tools (running them and sending back the
 * results) until it answers in text.
 */
export async function converse(
  config: GeminiConfig,
  system: string,
  contents: Content[],
  tools?: Tools,
): Promise<string> {
  const conversation = [...contents];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const reply = await generate(config, { system, contents: conversation, tools: tools?.declarations });
    conversation.push(reply);
    const calls = reply.parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []));
    if (calls.length === 0 || !tools) {
      const text = replyText(reply);
      if (!text) throw new GeminiError("other", "The reply had no text");
      return text;
    }
    const results = await Promise.all(
      calls.map(async (call) => {
        let response: Record<string, unknown>;
        try {
          response = await tools.run(call.name, call.args ?? {});
        } catch (error) {
          response = { error: error instanceof Error ? error.message : String(error) };
        }
        return { functionResponse: { name: call.name, response, ...(call.id ? { id: call.id } : {}) } };
      }),
    );
    conversation.push({ role: "user", parts: results });
  }
  throw new GeminiError("other", "Too many tool calls in a row");
}
