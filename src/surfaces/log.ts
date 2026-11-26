/**
 * One `[surfaces]` log line for a caught error (po-1447): the step, the ids
 * that are known, and a code. Never message text, titles, tokens or secrets:
 * the code is Slack's error code or the error's class, never its message.
 */
import { slackErrorCode, SlackApiError } from "./adapters/slack/api.js";

export type Step =
  | "oauth" | "events" | "interactions" | "commands" | "guard" | "ingest" | "judge" | "card" | "commit"
  | "purge" | "notice" | "seed" | "identity" | "home" | "dm" | "lifecycle" | "alert" | "budget" | "routing" | "settings" | "channels";

/** Slack's code or the class, plus a Node/DB system code such as `SQLITE_BUSY` when there is one. */
export function errorCode(err: unknown): string {
  const code = slackErrorCode(err);
  const sys = err instanceof SlackApiError ? null : (err as { code?: unknown } | null)?.code;
  return typeof sys === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(sys) ? `${code}:${sys}` : code;
}

// An id is a uuid-like token. Anything else (spaces, a Slack or Nest token) prints as "?".
const safeId = (v: string | number) => {
  const s = String(v);
  return /^[\w.:-]{1,80}$/.test(s) && !/^(xox|cnst_)/i.test(s) ? s : "?";
};

export function logCaught(
  step: Step,
  err: unknown,
  ids: Record<string, string | number | null | undefined> = {},
  level: "error" | "warn" = "error",
): void {
  const parts = Object.entries(ids).flatMap(([k, v]) => (v == null || v === "" ? [] : [`${k}=${safeId(v)}`]));
  console[level](`[surfaces] ${step} failed: code=${errorCode(err)}${parts.length ? ` ${parts.join(" ")}` : ""}`);
}
