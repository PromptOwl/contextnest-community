/**
 * Hootie's model call — the one place this server talks to Claude.
 *
 * Kept to one streaming round with a plain contract — text chunks out, tool
 * calls returned — so the route, the tool loop (agent.ts) and their tests
 * never touch the SDK: tests replace this module with a scripted round and
 * exercise everything else for real. The key is the
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

/** A tool the model may call — declaration only; running it is the caller's
 *  (see agent.ts). `input_schema` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A turn in a tool conversation: plain text, or content blocks (the
 *  assistant's blocks as returned, or the user's tool results). */
export interface ModelMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** How a round ended: the tools the model asked for (empty = it answered),
 *  and its content blocks verbatim, to send back with the tool results
 *  (thinking blocks must go back unchanged). */
export interface RoundResult {
  toolCalls: ToolCall[];
  assistant: unknown[];
}

export interface RoundParams extends Omit<AnswerParams, "turns"> {
  messages: ModelMessage[];
  /** Offered to the model; none → a plain request. */
  tools?: ToolSpec[];
  /** "none" on the last round: the model must answer now. */
  toolChoice?: "auto" | "none";
}

/**
 * Models (per gateway) that rejected the tuned request and answered the bare
 * one. The model name is admin-set and may be an older Claude or a gateway
 * model that knows nothing of adaptive thinking; remembered so only the first
 * question pays the extra round trip.
 */
const plainModels = new Set<string>();
/** Models (per gateway) that refused a request with tools and then answered
 *  one without: they are asked without tools from then on. */
const noToolModels = new Set<string>();
/** Refused a request with tools; confirmed tool-less once a plain request
 *  to them works (a 400 can also mean no credit or bad input). */
const toolSuspects = new Set<string>();

/** The model or gateway refused a request because it carried tools. The
 *  caller answers without them (Hootie: a deterministic broadening pass). */
export class ToolsRejectedError extends Error {
  constructor() {
    super("The model refused a request with tools.");
    this.name = "ToolsRejectedError";
  }
}

/**
 * Stream the assistant's answer as text chunks — one plain round, no tools.
 */
export async function* streamAnswer(params: AnswerParams): AsyncGenerator<string> {
  yield* streamRound({ ...params, messages: params.turns });
}

/**
 * One model round: stream its text, return the tool calls it ended on.
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
 *
 * Tools get the same treatment one level down: a request with tools that is
 * still refused (400, before any output) bare throws ToolsRejectedError, and
 * the caller retries without tools. A model is remembered as tool-less only
 * once a tool-less request to it then works.
 */
export async function* streamRound(params: RoundParams): AsyncGenerator<string, RoundResult> {
  const client = clientFor(params.apiKey, params.baseUrl ?? null);
  const key = `${params.baseUrl ?? ""}|${params.model}`;
  const withTools = !!params.tools?.length;
  if (withTools && noToolModels.has(key)) throw new ToolsRejectedError();
  const confirm = (result: RoundResult) => {
    if (!withTools && toolSuspects.delete(key)) noToolModels.add(key);
    return result;
  };
  if (plainModels.has(key)) {
    const state = { started: false };
    try {
      return confirm(yield* answer(client, params, false, state));
    } catch (err) {
      throw toolRejection(err, params, key, state.started);
    }
  }
  const state = { started: false };
  try {
    return confirm(yield* answer(client, params, true, state));
  } catch (err) {
    if (state.started || (err as { status?: number })?.status !== 400) throw err;
    console.log(`[hootie] model=${params.model} rejected the tuned request (400); retrying bare`);
    const bareState = { started: false };
    let result: RoundResult;
    try {
      result = yield* answer(client, params, false, bareState);
    } catch (bare) {
      throw toolRejection(bare, params, key, bareState.started);
    }
    plainModels.add(key);
    return confirm(result);
  }
}

/** A bare request with tools refused before any output → ToolsRejectedError. */
function toolRejection(err: unknown, params: RoundParams, key: string, started: boolean): unknown {
  if (!params.tools?.length || started || (err as { status?: number })?.status !== 400) return err;
  console.log(`[hootie] ${key} refused a request with tools (400); answering without`);
  // Only a first round says the model refuses tools: a later one already took
  // them, so its 400 is about the tool history, not tools.
  if (params.messages.every((m) => typeof m.content === "string")) toolSuspects.add(key);
  return new ToolsRejectedError();
}

async function* answer(
  client: Anthropic,
  params: RoundParams,
  tuned: boolean,
  state = { started: false },
): AsyncGenerator<string, RoundResult> {
  const startedAt = Date.now();
  const last = params.messages[params.messages.length - 1]?.content ?? "";
  const tools = params.tools?.length
    ? {
        tools: params.tools as Anthropic.Messages.Tool[],
        tool_choice: { type: params.toolChoice ?? "auto" } as Anthropic.Messages.ToolChoice,
      }
    : {};
  console.log(
    `[hootie] → request model=${params.model} base=${params.baseUrl || "anthropic"} tuned=${tuned} ` +
      `system=${params.system.length} chars turns=${params.messages.length} ` +
      `last=${typeof last === "string" ? `${last.length} chars` : "blocks"} tools=${params.tools?.length ?? 0}` +
      (params.tools?.length ? `/${params.toolChoice ?? "auto"}` : ""),
  );
  if (config.HOOTIE_DEBUG_LOG) {
    console.log("[hootie][debug] system:\n" + params.system);
    console.log("[hootie][debug] turns:\n" + JSON.stringify(params.messages, null, 2));
  }
  const messages = params.messages as Anthropic.Messages.MessageParam[];
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
          messages,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          ...tools,
        }
      : // The bare request every Messages-speaking model accepts.
        {
          model: params.model,
          max_tokens: 4096,
          system: params.system,
          messages,
          ...tools,
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
  const content = (final.content ?? []) as Anthropic.Messages.ContentBlock[];
  const text = content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const toolCalls: ToolCall[] = content
    .filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  const u = final.usage;
  console.log(
    `[hootie] ← response model=${final.model} stop=${final.stop_reason} in=${u?.input_tokens ?? "?"} ` +
      `out=${u?.output_tokens ?? "?"} cache_read=${u?.cache_read_input_tokens ?? 0} ` +
      `text=${text.length} chars tool_calls=${toolCalls.length} ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  if (config.HOOTIE_DEBUG_LOG) console.log("[hootie][debug] answer:\n" + text);
  if (final.stop_reason === "refusal") {
    throw new ModelRefusedError(
      final.stop_details?.explanation || "The model declined to answer that.",
    );
  }
  return { toolCalls, assistant: content };
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
