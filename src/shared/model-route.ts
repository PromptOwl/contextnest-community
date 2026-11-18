/**
 * PromptOwl's licence gateway as the fallback for a failing own key (po-1419).
 *
 * resolveModelCredential picks ONE credential: a nest's own key, the server's
 * own gateway, or PromptOwl's licence gateway. Before this, a failure on the
 * picked one was final: on 2026-11-18 production's Slack listener failed all
 * day on an Anthropic account that was out of credit. Now a call on an own
 * credential that fails for a reason that is about the account or the
 * endpoint (billing, auth, rate limit after the SDK's retries, 5xx, no
 * connection) is retried ONCE on PromptOwl's gateway, if the licence has one
 * and the server admin has not turned the fallback off
 * (`model_fallback_promptowl`, Settings → Hootie; MCP context_model_route_*).
 * A 400 about the request itself never falls back: PromptOwl would refuse it
 * the same way, and it would be billed twice.
 *
 * The one place this happens: a ModelRoute wraps the credential and the call.
 * createTurn (metacognition, the team chat watcher, the Surfaces judge,
 * summaries, distill) and Hootie's round loop (Hootie chat, ask-nest) call
 * through it, so no caller has its own copy. A route is sticky: once it has
 * fallen back, the rest of the run stays on PromptOwl's gateway rather than
 * paying a failed round trip per turn.
 *
 * The pair rule holds: the fallback credential is the licence gateway's own
 * key and URL, built from getModelGateway() alone. The source credential's
 * key is never sent to PromptOwl.
 */
import { config } from "../config.js";
import { getModelGateway } from "../auth/license.js";
import { bareModelName, credentialLabel, resolveGatewayModel, resolveModelCredential, type ModelCredential } from "./model-credential.js";

/**
 * An out-of-credit / billing refusal. Anthropic answers 400 "Your credit
 * balance is too low to access the Anthropic API"; LiteLLM's BadRequestError
 * wraps that body in its own message; other providers say 402 or "quota".
 * Only matched, never kept or logged.
 */
export const BILLING_RE =
  /credit balance|billing|insufficient[_ ](?:quota|funds|credit)|exceeded your current quota|out of credit|payment required/i;

/** How a model call failed, in the reason codes the Surfaces ledger uses (po-1407). */
export type ModelFailureCode =
  | "model_auth"
  | "model_billing"
  | "model_rate_limited"
  | "model_timeout"
  | "model_rejected"
  | "model_error";

/** Every message the error carries (the SDK puts the API's under error.error.message). */
export function messagesOf(err: unknown): string {
  const e = err as { message?: unknown; error?: { message?: unknown; error?: { message?: unknown } } } | null;
  return [e?.message, e?.error?.message, e?.error?.error?.message].filter((m) => typeof m === "string").join(" ");
}

/** The error's class name (the SDK's classes leave `name` as "Error"); never its message. */
export function errorNameOf(err: unknown): string {
  if (!(err instanceof Error)) return "error";
  const n = err.name && err.name !== "Error" ? err.name : err.constructor?.name || "Error";
  return /^[A-Za-z0-9_$.]{1,60}$/.test(n) ? n : "Error";
}

export function httpStatusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" && Number.isInteger(s) && s >= 100 && s <= 599 ? s : null;
}

const TIMEOUT_NAMES = new Set(["AbortError", "TimeoutError", "APIConnectionTimeoutError", "APIUserAbortError"]);
/** The SDK could not reach the endpoint (DNS, refused, reset, its own timeout). */
const CONNECTION_NAMES = new Set(["APIConnectionError", "APIConnectionTimeoutError"]);

export function isBillingError(err: unknown): boolean {
  const status = httpStatusOf(err);
  return status === 402 || ((status === 400 || status === 429) && BILLING_RE.test(messagesOf(err)));
}

/** A failed model call's reason code: the judge's model-stage classification. */
export function modelFailureCode(err: unknown): ModelFailureCode {
  const name = errorNameOf(err);
  const status = httpStatusOf(err);
  if (TIMEOUT_NAMES.has(name)) return "model_timeout";
  if (status === 401 || status === 403) return "model_auth";
  if (isBillingError(err)) return "model_billing";
  if (status === 429) return "model_rate_limited";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "model_rejected";
  return "model_error";
}

export type FallbackReason = Exclude<ModelFailureCode, "model_rejected">;

/**
 * Whether this failure is about the account or the endpoint, so PromptOwl's
 * gateway may answer instead; null = it is about the request (or ours), and
 * the error stands.
 *
 * - billing (402, or a 400/429 naming credit/billing/quota) → model_billing
 * - 401 / 403 → model_auth
 * - 429 (the SDK has already spent its retries) → model_rate_limited
 * - 5xx, 529 overloaded → model_error
 * - no connection (DNS, refused, reset) → model_error; the SDK's own timeout → model_timeout
 * - never: a request-shaped 400/404/413/422, our own abort, a refusal, a tools rejection, a bug
 */
export function fallbackReason(err: unknown): FallbackReason | null {
  const name = errorNameOf(err);
  const status = httpStatusOf(err);
  if (isBillingError(err)) return "model_billing";
  if (status === 401 || status === 403) return "model_auth";
  if (status === 429) return "model_rate_limited";
  if (status !== null && status >= 500) return "model_error";
  if (status === null && CONNECTION_NAMES.has(name)) {
    return name === "APIConnectionTimeoutError" ? "model_timeout" : "model_error";
  }
  return null;
}

/**
 * PromptOwl's licence gateway as a fallback for `primary`, or null: the
 * primary is already PromptOwl's, the setting is off, the licence has no
 * gateway, or it is the very same key. Built from the licence alone (pair
 * rule): nothing of `primary` goes into it.
 */
export function promptOwlFallbackFor(primary: ModelCredential): ModelCredential | null {
  if (primary.source !== "own" || !config.MODEL_FALLBACK_PROMPTOWL) return null;
  const gateway = getModelGateway();
  if (!gateway || gateway.key === primary.apiKey) return null;
  return { apiKey: gateway.key, baseUrl: gateway.baseUrl, source: "promptowl", defaultModel: gateway.defaultModel };
}

/** The ledger / trace line for a fallback. */
export function fallbackNote(reason: FallbackReason): string {
  return `answered via PromptOwl gateway (fallback: ${reason})`;
}

/** What a run trace records when a route fell back. */
export interface ModelRouteTrace {
  source: "promptowl";
  fallback: FallbackReason;
  /** The failed call's HTTP status, when it had one (never its message). */
  status: number | null;
  model: string;
  note: string;
}

export class ModelRoute {
  credential: ModelCredential;
  model: string;
  fallback: ModelRouteTrace | null = null;

  /**
   * @param fallbackModel the name to ask PromptOwl's gateway for, when it is
   *   known up front (Hootie's own-provider route: the team model it renamed);
   *   otherwise the bare name is looked up on the gateway (resolveGatewayModel).
   */
  constructor(credential: ModelCredential, model: string, private readonly opts: { fallbackModel?: string } = {}) {
    this.credential = credential;
    this.model = model;
  }

  /** One call; on a fallback reason, the same call once more on PromptOwl's gateway. */
  async call<T>(run: (credential: ModelCredential, model: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await run(this.credential, this.model);
    } catch (err) {
      if (!(await this.switchFor(err, signal))) throw err;
    }
    return run(this.credential, this.model);
  }

  /**
   * A streamed call: falls back only when the failure came before anything
   * was yielded. Once text has reached the person, a second answer would be
   * a different one.
   */
  async *stream<Y, R>(
    open: (credential: ModelCredential, model: string) => AsyncGenerator<Y, R>,
    signal?: AbortSignal,
  ): AsyncGenerator<Y, R> {
    let yielded = false;
    try {
      const first = open(this.credential, this.model);
      for (;;) {
        const next = await first.next();
        if (next.done) return next.value;
        yielded = true;
        yield next.value;
      }
    } catch (err) {
      if (yielded || !(await this.switchFor(err, signal))) throw err;
    }
    return yield* open(this.credential, this.model);
  }

  /** Spread into a run trace: `model_route` only when the route fell back. */
  trace(): { model_route?: ModelRouteTrace } {
    return this.fallback ? { model_route: this.fallback } : {};
  }

  /** "own_key" | "promptowl_credits", for the credential that answered. */
  billing(): "own_key" | "promptowl_credits" {
    return this.credential.source === "own" ? "own_key" : "promptowl_credits";
  }

  private async switchFor(err: unknown, signal?: AbortSignal): Promise<boolean> {
    if (this.fallback || signal?.aborted) return false;
    const reason = fallbackReason(err);
    if (!reason) return false;
    const target = promptOwlFallbackFor(this.credential);
    if (!target) return false;
    const model = this.opts.fallbackModel ?? (await resolveGatewayModel(target, bareModelName(this.model)));
    const status = httpStatusOf(err);
    console.warn(
      `[model-route] ${credentialLabel(this.credential)} model=${this.model} failed reason=${reason}` +
        `${status ? ` status=${status}` : ""}; retrying once on PromptOwl's gateway model=${model} (${credentialLabel(target)})`,
    );
    this.credential = target;
    this.model = model;
    this.fallback = { source: "promptowl", fallback: reason, status, model, note: fallbackNote(reason) };
    return true;
  }
}

/** The server's fallback setting as REST and MCP report it (po-1419). */
export function modelRouteSettings(): {
  model_fallback_promptowl: boolean;
  model_fallback_available: boolean;
  model_source: ModelCredential["source"] | null;
} {
  return {
    model_fallback_promptowl: config.MODEL_FALLBACK_PROMPTOWL,
    // It only acts when the licence hands out a gateway.
    model_fallback_available: !!getModelGateway(),
    model_source: resolveModelCredential()?.source ?? null,
  };
}
