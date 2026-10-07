/**
 * One turn of a metacognition agent's ReAct loop: a Messages API call with
 * tools. Kept to a single function with a plain contract so the loop (and its
 * tests) never touch the SDK — tests replace `createTurn` with a script and
 * exercise everything else for real, the way Hootie's tests replace
 * streamAnswer.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ModelCredential } from "../shared/model-credential.js";

export interface TurnRequest {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  max_tokens: number;
}

export interface TurnResult {
  content: Anthropic.ContentBlock[] | Array<Record<string, unknown>>;
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  stop_details?: { explanation?: string | null } | null;
}

/**
 * Models (per endpoint) that rejected the tuned request and took the bare one.
 * The model is admin-set and may be a gateway model that knows nothing of
 * adaptive thinking or effort; remembered so only the first turn pays the
 * extra round trip — the same rule as Hootie's model call.
 */
const plainModels = new Set<string>();

/**
 * Non-streaming on purpose: a turn is a bounded `max_tokens` (the loop caps
 * it), the loop needs the whole message before it can run tools, and nothing
 * renders tokens as they arrive. Adaptive thinking at `medium` effort: the
 * work is reading and proposing, not deep reasoning, and every turn is billed.
 * Thinking blocks come back in `content` and the loop appends them unchanged.
 */
export async function createTurn(params: {
  credential: ModelCredential;
  request: TurnRequest;
  signal?: AbortSignal;
}): Promise<TurnResult> {
  const { credential, request, signal } = params;
  const client = clientFor(credential.apiKey, credential.baseUrl);
  const key = `${credential.baseUrl ?? ""}|${request.model}`;
  const base = {
    model: request.model,
    max_tokens: request.max_tokens,
    // The instructions and the agent's memory open every request of a run
    // unchanged, so they are worth caching across its turns.
    system: [{ type: "text" as const, text: request.system, cache_control: { type: "ephemeral" as const } }],
    messages: request.messages,
    tools: request.tools,
  };
  if (!plainModels.has(key)) {
    try {
      return (await client.messages.create(
        { ...base, thinking: { type: "adaptive" }, output_config: { effort: "medium" } } as any,
        { signal },
      )) as TurnResult;
    } catch (err) {
      if ((err as { status?: number })?.status !== 400) throw err;
      const plain = (await client.messages.create(base, { signal })) as TurnResult;
      plainModels.add(key);
      return plain;
    }
  }
  return (await client.messages.create(base, { signal })) as TurnResult;
}

let cached: { apiKey: string; baseUrl: string | null; client: Anthropic } | null = null;
function clientFor(apiKey: string, baseUrl: string | null): Anthropic {
  if (!cached || cached.apiKey !== apiKey || cached.baseUrl !== baseUrl) {
    cached = { apiKey, baseUrl, client: new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) }) };
  }
  return cached.client;
}

/**
 * List price per million tokens, by model family, for the run's cost
 * ESTIMATE. Not a bill: PromptOwl's gateway meters credits itself, and an own
 * key is billed by the customer's provider. A model this doesn't recognise
 * gets no estimate rather than a wrong one.
 */
const PRICES: Array<[RegExp, { input: number; output: number; cacheRead: number; cacheWrite: number }]> = [
  [/fable|mythos/i, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  [/opus-5-5/i, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  [/opus/i, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/sonnet-5/i, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  [/sonnet/i, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/haiku/i, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
];

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export function estimateCostUsd(model: string, u: Usage): number | null {
  const hit = PRICES.find(([re]) => re.test(model));
  if (!hit) return null;
  const p = hit[1];
  const usd =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_input_tokens * p.cacheRead +
      u.cache_creation_input_tokens * p.cacheWrite) /
    1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}
