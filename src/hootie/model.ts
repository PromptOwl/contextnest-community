/**
 * Hootie's model call — the one place this server talks to Claude.
 *
 * Kept to a single streaming function with a plain-text contract so the route
 * (and its tests) never touch the SDK: tests replace this module with a
 * scripted generator and exercise everything else for real. The server-wide
 * ANTHROPIC_API_KEY that the superadmin sets for agent runners is the only
 * credential; there is no per-user key.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export interface ModelTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Stream the assistant's answer as text chunks.
 *
 * Adaptive thinking stays on (the model's default); effort is capped at
 * `medium` because a grounded Q&A over a few documents doesn't need more, and
 * a chat panel is latency-sensitive. `max_tokens` caps a runaway answer, not
 * a normal one: a cited chat reply is a few hundred tokens, and 4096 leaves
 * room for a long list without letting a loop run to the model's ceiling.
 * `signal` cancels the stream when the client hangs up.
 */
export async function* streamAnswer(params: {
  apiKey: string;
  model: string;
  /** A gateway (LiteLLM, PromptOwl) speaking /v1/messages; null = Anthropic. */
  baseUrl?: string | null;
  system: string;
  turns: ModelTurn[];
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const client = clientFor(params.apiKey, params.baseUrl ?? null);
  const stream = client.messages.stream(
    {
      model: params.model,
      max_tokens: 4096,
      // The system prompt carries the retrieved context, which is the bulk of
      // the request and identical across a conversation's turns — cache it.
      system: [
        {
          type: "text",
          text: params.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: params.turns,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    },
    { signal: params.signal },
  );
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
  const final = await stream.finalMessage();
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
export function describeModelError(err: unknown): string {
  const e = err as { status?: number; error?: { error?: { message?: string } } };
  const detail = (e?.error?.error?.message || "").toLowerCase();
  // Behind a gateway the rejection is the gateway's, not Anthropic's.
  const provider = config.ANTHROPIC_BASE_URL ? "The model gateway" : "Anthropic";
  if (detail.includes("credit balance") || detail.includes("billing")) {
    return "Hootie's Anthropic account is out of credit. A server admin needs to add credit in the Anthropic console (Plans & Billing).";
  }
  switch (e?.status) {
    case 401:
    case 403:
      return `${provider} rejected this server's API key. A server admin can replace it under Settings → General.`;
    case 404:
      return `No model named "${config.HOOTIE_MODEL}" is available on this key. A server admin can change it under Settings → General.`;
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
 * Does this key actually work? Called when an admin saves one, so an invalid
 * key is refused at the box that sets it rather than surfacing as a failed
 * answer later.
 *
 * `models.list` is the cheapest call that proves the credential: no tokens,
 * no model named, one round trip. Only an auth rejection (401/403) is a
 * verdict — anything else (gateway down, no /v1/models on it, a timeout) says
 * nothing about the key, so the save goes through rather than holding the
 * admin hostage to an unrelated outage.
 *
 * @returns an error to show the admin, or null when there's nothing against it.
 */
export async function verifyModelKey(
  apiKey: string,
  baseUrl: string | null,
): Promise<string | null> {
  try {
    await clientFor(apiKey, baseUrl).models.list(
      { limit: 1 },
      { signal: AbortSignal.timeout(10_000) },
    );
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
