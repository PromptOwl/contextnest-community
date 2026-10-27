/**
 * Hootie's model call — the one place this server talks to Claude.
 *
 * Kept to a single streaming function with a plain-text contract so the route
 * (and its tests) never touch the SDK: tests replace this module with a
 * scripted generator and exercise everything else for real. The key is the
 * route's (the server's own gateway, PromptOwl's gateway, or the licence's
 * own-provider key); there is no per-user key.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export interface ModelTurn {
  role: "user" | "assistant";
  content: string;
}

interface AnswerParams {
  apiKey: string;
  model: string;
  /** A gateway (LiteLLM, PromptOwl) speaking /v1/messages; null = Anthropic. */
  baseUrl?: string | null;
  system: string;
  turns: ModelTurn[];
  signal?: AbortSignal;
}

/**
 * Models (per gateway) that rejected the tuned request and answered the bare
 * one. The model name is admin-set and may be an older Claude or a gateway
 * model that knows nothing of adaptive thinking; remembered so only the first
 * question pays the extra round trip.
 */
const plainModels = new Set<string>();

/**
 * Stream the assistant's answer as text chunks.
 *
 * Adaptive thinking at `medium` effort: a grounded Q&A over a few documents
 * doesn't need more, and a chat panel is latency-sensitive. `max_tokens` caps
 * a runaway answer, not a normal one. No temperature / top_p / top_k — current
 * Claude models reject them outright. `signal` cancels on client hang-up.
 *
 * Not every model takes thinking or effort (Haiku 4.5 and older Claude reject
 * both; gateway models vary), so a 400 before any output retries once with
 * the bare request. The model is only remembered as plain when that retry
 * works — a 400 that fails both ways (no credit, bad input) changes nothing.
 */
export async function* streamAnswer(params: AnswerParams): AsyncGenerator<string> {
  const client = clientFor(params.apiKey, params.baseUrl ?? null);
  const key = `${params.baseUrl ?? ""}|${params.model}`;
  if (plainModels.has(key)) {
    yield* answer(client, params, false);
    return;
  }
  const state = { started: false };
  try {
    yield* answer(client, params, true, state);
  } catch (err) {
    if (state.started || (err as { status?: number })?.status !== 400) throw err;
    console.log(`[hootie] model=${params.model} rejected the tuned request (400); retrying bare`);
    yield* answer(client, params, false);
    plainModels.add(key);
  }
}

async function* answer(
  client: Anthropic,
  params: AnswerParams,
  tuned: boolean,
  state = { started: false },
): AsyncGenerator<string> {
  const startedAt = Date.now();
  const question = params.turns[params.turns.length - 1]?.content ?? "";
  console.log(
    `[hootie] → request model=${params.model} base=${params.baseUrl || "anthropic"} tuned=${tuned} ` +
      `system=${params.system.length} chars turns=${params.turns.length} question=${question.length} chars`,
  );
  if (config.HOOTIE_DEBUG_LOG) {
    console.log("[hootie][debug] system:\n" + params.system);
    console.log("[hootie][debug] turns:\n" + JSON.stringify(params.turns, null, 2));
  }
  const stream = client.messages.stream(
    tuned
      ? {
          model: params.model,
          max_tokens: 4096,
          // The system prompt carries the retrieved context — the bulk of the
          // request, identical across a conversation's turns — so cache it.
          system: [
            { type: "text", text: params.system, cache_control: { type: "ephemeral" } },
          ],
          messages: params.turns,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
        }
      : // The bare request every Messages-speaking model accepts.
        {
          model: params.model,
          max_tokens: 4096,
          system: params.system,
          messages: params.turns,
        },
    { signal: params.signal },
  );
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      state.started = true;
      yield event.delta.text;
    }
  }
  const final = await stream.finalMessage();
  const text = (final.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
  const u = final.usage;
  console.log(
    `[hootie] ← response model=${final.model} stop=${final.stop_reason} in=${u?.input_tokens ?? "?"} ` +
      `out=${u?.output_tokens ?? "?"} cache_read=${u?.cache_read_input_tokens ?? 0} ` +
      `text=${text.length} chars ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  if (config.HOOTIE_DEBUG_LOG) console.log("[hootie][debug] answer:\n" + text);
  if (final.stop_reason === "refusal") {
    throw new ModelRefusedError(
      final.stop_details?.explanation || "The model declined to answer that.",
    );
  }
}

/**
 * What to tell the person in the panel when the model call failed.
 *
 * "Hootie couldn't reach the model" is true of every failure and useful for
 * none of them: out of credit, a revoked key and a rate limit each need a
 * different person to do a different thing. The provider says which; this
 * turns that into one sentence naming the cause and who fixes it.
 *
 * Deliberately our own wording rather than the provider's text: it reaches
 * every reader of the nest, not just the admin, and an upstream message can
 * change or say more than we want to repeat.
 */
/** `model` / `gateway`: the call actually made (it may be the PromptOwl gateway). */
export function describeModelError(
  err: unknown,
  call: { model?: string; gateway?: boolean } = {},
): string {
  const model = call.model ?? config.HOOTIE_MODEL;
  const e = err as { status?: number; error?: { error?: { message?: string } } };
  const detail = (e?.error?.error?.message || "").toLowerCase();
  // Behind a gateway the rejection is the gateway's, not Anthropic's.
  const provider = call.gateway ? "The model gateway" : "Anthropic";
  if (detail.includes("credit balance") || detail.includes("billing")) {
    return "Hootie's Anthropic account is out of credit. A server admin needs to add credit in the Anthropic console (Plans & Billing).";
  }
  // LiteLLM answers 400 for a model name it doesn't serve.
  if (detail.includes("no healthy deployments") || detail.includes("invalid model name")) {
    return `No model named "${model}" is available on this key. A server admin can pick one under Server settings → Hootie.`;
  }
  switch (e?.status) {
    case 401:
    case 403:
      return `${provider} rejected this server's API key. A server admin can replace it under Server settings → Hootie.`;
    case 404:
      return `No model named "${model}" is available on this key. A server admin can pick one under Server settings → Hootie.`;
    case 413:
      return "That question plus the documents behind it are too large for one request. Try asking something narrower.";
    case 429:
      return `${provider} is rate-limiting this server right now. Try again in a moment.`;
    case 529:
      return "The model is overloaded right now. Try again in a moment.";
  }
  if (typeof e?.status === "number" && e.status >= 500) {
    return `${provider} is having trouble right now. Try again in a moment.`;
  }
  return "Hootie couldn't reach the model. Try again in a moment.";
}

/**
 * Does this key work on this gateway? Called when an admin saves the server's
 * own gateway key, so a bad one is refused at the box that sets it rather than
 * surfacing as a failed answer later.
 *
 * `models.list` is the cheapest call that proves the credential: no tokens,
 * no model named, one round trip. Only an auth rejection (401/403) is a
 * verdict — anything else (gateway down, no /v1/models on it, a timeout) says
 * nothing about the key, so the save goes through.
 *
 * @returns an error to show the admin, or null when there's nothing against it.
 */
export async function verifyModelKey(apiKey: string, baseUrl: string | null): Promise<string | null> {
  try {
    await clientFor(apiKey, baseUrl).models.list({ limit: 1 }, { signal: AbortSignal.timeout(10_000) });
    return null;
  } catch (err: any) {
    const status = err?.status;
    if (status === 401 || status === 403) {
      return baseUrl
        ? `The model gateway rejected that key (${status}). Check the key and the gateway URL.`
        : "Anthropic rejected that key. Check it and paste it again.";
    }
    console.warn("[hootie] key check inconclusive, saving anyway", status ?? err?.message);
    return null;
  }
}

/**
 * One client per key + gateway. Both are server-wide settings an admin can
 * change at runtime, so they are looked up per call — but the client behind
 * them (connection pool, retries) is reused rather than rebuilt per question.
 */
let cached: { apiKey: string; baseUrl: string | null; client: Anthropic } | null = null;
function clientFor(apiKey: string, baseUrl: string | null): Anthropic {
  if (!cached || cached.apiKey !== apiKey || cached.baseUrl !== baseUrl) {
    cached = {
      apiKey,
      baseUrl,
      client: new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) }),
    };
  }
  return cached.client;
}

export class ModelRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRefusedError";
  }
}
