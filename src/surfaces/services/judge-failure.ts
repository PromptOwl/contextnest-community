/**
 * Why a judge run failed, in one fixed code (po-1407).
 *
 * A throw out of the judge ends the window as `error` with one of these
 * codes on the window and on its failed run, so the Control room ledger, the
 * trace and the MCP ledger tools can say why. The codes sit beside the
 * judge's own (`no_listener`, `no_model`, `nest_unreadable`, …).
 *
 * Nothing here keeps an error's message: model and Slack errors can carry a
 * key fragment or chat text. Only the class name and the HTTP status leave.
 */
import { SlackApiError } from "../adapters/slack/api.js";
import { SurfaceRateLimited } from "../contract.js";

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
    public readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.name : "judge run failed");
    this.name = "JudgeRunError";
  }
}

/**
 * An out-of-credit / billing refusal. Anthropic answers 400 "Your credit
 * balance is too low to access the Anthropic API"; LiteLLM's BadRequestError
 * wraps that body in its own message; other providers say 402 or "quota".
 * Only matched here, never kept or logged.
 */
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

/** The one server-log line for a failure: name, code, status. No message, no chat. */
export function judgeFailureLogLine(windowId: string, f: JudgeFailure): string {
  return `[surfaces] judging window ${windowId} failed: ${f.name} reason=${f.code}${f.status ? ` status=${f.status}` : ""}`;
}
