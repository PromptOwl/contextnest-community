/**
 * Why a judge run failed, as one fixed code on the window and its failed run (po-1407).
 * The class name and HTTP status are kept. An error's message is kept only for the codes whose
 * fixed words don't say enough, and only after `safeErrorMessage` took out secrets and chat text.
 */
import { SlackApiError } from "../adapters/slack/api.js";
import { SurfaceRateLimited } from "../contract.js";
import { redact } from "../../notify/outbound-log.js";

export const JUDGE_FAILURE_CODES = [
  "model_auth",
  "model_billing",
  "model_rate_limited",
  "model_timeout",
  "model_rejected",
  "model_error",
  "slack_fetch_failed",
  "nest_read_failed",
  "invalid_output",
  "output_limit",
  "no_verdict",
  "db_error",
  "unknown_error",
] as const;
export type JudgeFailureCode = (typeof JUDGE_FAILURE_CODES)[number];

/** Where the judge was when it threw: what decides an error with no type of its own. */
export type JudgeStage = "setup" | "nest" | "slack" | "model" | "verdict" | "commit";

export interface JudgeFailure {
  code: JudgeFailureCode;
  /** The error's class name (never its message). */
  name: string;
  /** The HTTP status, when the error carries one. */
  status: number | null;
  /** What exactly went wrong: a validation rule, a stop reason or a cleaned provider message. */
  detail?: string | null;
}

export interface JudgeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A judge run that failed part-way; carries what it already spent (round 2, L1) and the original error. */
export class JudgeRunError extends Error {
  constructor(
    public readonly usage: JudgeUsage,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.name : "judge run failed", { cause });
    this.name = "JudgeRunError";
  }
}

/** Each code in words, as shown on the run (the Control room words are REASON_TEXT in the UI). */
export const JUDGE_FAILURE_TEXT: Record<JudgeFailureCode, string> = {
  model_auth: "The model key was refused.",
  model_billing: "The model account is out of credit.",
  model_rate_limited: "The model is rate-limited. Try again later.",
  model_timeout: "The model call timed out. Raise the listener's time limit or choose a faster model.",
  model_rejected: "The model refused the request.",
  model_error: "The model call failed.",
  slack_fetch_failed: "Couldn't reach Slack.",
  nest_read_failed: "Couldn't read the nest.",
  invalid_output: "The model's decision was invalid.",
  output_limit: "The model ran out of output tokens before it answered. Raise the listener's max output tokens or choose another model.",
  no_verdict: "The model answered without submitting a decision.",
  db_error: "Database error.",
  unknown_error: "Unexpected error.",
};

/** The failure in one line, for the run's `error`. */
export function judgeFailureText(f: JudgeFailure): string {
  return `${JUDGE_FAILURE_TEXT[f.code]}${f.detail ? ` (${f.detail})` : ""}`;
}

/** Codes whose words don't say enough on their own: these carry the error's own message. */
const WITH_MESSAGE = new Set<JudgeFailureCode>(["model_rejected", "model_error", "slack_fetch_failed", "nest_read_failed", "db_error", "unknown_error"]);
const MAX_DETAIL = 300;
/** Words a provider error needs to make sense; never masked, even if the chat used them too. */
const PLAIN_WORDS =
  /^(?:model|models|token|tokens|max_tokens|max_completion_tokens|temperature|request|error|invalid|invalid_request_error|limit|parameter|unsupported|support|supported|value|message|messages|timeout|connection|with|this|that|does|only|default|not|from|the)$/i;

/**
 * An error's own message, safe to store and log: credentials redacted, and every
 * word of the judged conversation masked (AC-BUF-05: chat text never reaches a
 * log or a table), since a provider can echo what it was sent.
 */
export function safeErrorMessage(err: unknown, chat: string[]): string | null {
  const cause = err instanceof JudgeRunError ? err.cause : err;
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  if (!raw.trim()) return null;
  const said = new Set(chat.flatMap((t) => t.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length >= 3));
  return redact(raw)
    .replace(/[\p{L}\p{N}_]+/gu, (w) => (said.has(w.toLowerCase()) && !PLAIN_WORDS.test(w) ? "…" : w))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DETAIL);
}

/** Out-of-credit refusal: Anthropic's 400 "credit balance is too low" (raw or LiteLLM-wrapped), 402, or "quota". Matched only, never kept. */
const BILLING_RE = /credit balance|billing|insufficient[_ ](?:quota|funds|credit)|exceeded your current quota|out of credit|payment required/i;

/** Every message the error carries (the SDK puts the API's under error.error.message). */
function messagesOf(err: unknown): string {
  const e = err as { message?: unknown; error?: { message?: unknown; error?: { message?: unknown } } } | null;
  return [e?.message, e?.error?.message, e?.error?.error?.message].filter((m) => typeof m === "string").join(" ");
}

const TIMEOUT_NAMES = new Set(["AbortError", "TimeoutError", "APIConnectionTimeoutError", "APIUserAbortError"]);
const PARSE_NAMES = new Set(["SyntaxError", "ZodError"]);

function nameOf(err: unknown): string {
  if (!(err instanceof Error)) return "error";
  // The SDK's error classes leave `name` as "Error": the class name says more.
  const n = err.name && err.name !== "Error" ? err.name : err.constructor?.name || "Error";
  return /^[A-Za-z0-9_$.]{1,60}$/.test(n) ? n : "Error";
}

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" && Number.isInteger(s) && s >= 100 && s <= 599 ? s : null;
}

/** SQLite (better-sqlite3) or Postgres (a SQLSTATE code with a severity). */
function isDbError(err: unknown, name: string): boolean {
  if (name === "SqliteError" || name === "DatabaseError") return true;
  const e = err as { code?: unknown; severity?: unknown } | null;
  return typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.severity === "string";
}

export function classifyJudgeFailure(err: unknown, stage: JudgeStage): JudgeFailure {
  const fromModel = err instanceof JudgeRunError;
  const cause = fromModel ? (err as JudgeRunError).cause : err;
  const name = nameOf(cause);
  const status = statusOf(cause);
  const out = (code: JudgeFailureCode): JudgeFailure => ({ code, name, status });

  if (cause instanceof SlackApiError || cause instanceof SurfaceRateLimited) return out("slack_fetch_failed");
  // Settling spend after a failed call runs in the model stage: its DB error is not the model's.
  if (!fromModel && isDbError(cause, name)) return out("db_error");
  if (fromModel || stage === "model") {
    if (TIMEOUT_NAMES.has(name)) return out("model_timeout");
    if (status === 401 || status === 403) return out("model_auth");
    if (status === 402 || ((status === 400 || status === 429) && BILLING_RE.test(messagesOf(cause)))) return out("model_billing");
    if (status === 429) return out("model_rate_limited");
    if (status === 400 || status === 404 || status === 413 || status === 422) return out("model_rejected");
    return out("model_error");
  }
  if (PARSE_NAMES.has(name)) return out("invalid_output");
  if (stage === "slack") return out("slack_fetch_failed");
  if (stage === "nest") return out("nest_read_failed");
  if (stage === "verdict") return out("invalid_output");
  return out("unknown_error");
}

/**
 * An agent run's failure (channel watcher, metacognition runner): an error
 * with an HTTP status or a timeout came from the model; anything else keeps
 * its own class (db_error, invalid_output, unknown_error).
 */
export function classifyRunFailure(err: unknown, timedOut = false): JudgeFailure {
  if (timedOut) return { code: "model_timeout", name: nameOf(err), status: statusOf(err) };
  const fromModel = statusOf(err) !== null || TIMEOUT_NAMES.has(nameOf(err));
  return classifyJudgeFailure(err, fromModel ? "model" : "setup");
}

/** A thrown failure, classified, with the error's own cleaned message when the code alone doesn't explain it. */
export function describeJudgeFailure(err: unknown, stage: JudgeStage, chat: string[]): JudgeFailure {
  const f = classifyJudgeFailure(err, stage);
  return WITH_MESSAGE.has(f.code) ? { ...f, detail: safeErrorMessage(err, chat) } : f;
}

/** The one server-log line for a failure: name, code, status, cleaned detail and run facts. No chat. */
export function judgeFailureLogLine(windowId: string, f: JudgeFailure, facts: Record<string, string | number | null | undefined> = {}): string {
  const extra = Object.entries({ ...facts, detail: f.detail ? JSON.stringify(f.detail) : null })
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => ` ${k}=${v}`)
    .join("");
  return `[surfaces] judging window ${windowId} failed: ${f.name} reason=${f.code}${f.status ? ` status=${f.status}` : ""}${extra}`;
}
