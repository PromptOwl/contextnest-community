/**
 * Handles no agent may claim (team chat C7, PO-1198).
 *
 * `hootie` and `nest` address the nest's own assistant in a conversation
 * (src/agents/ask-nest.ts); `channel`, `here` and `everyone` are broadcast
 * words (C1 wires @channel / @here). A webhook saved under one of them, or a
 * message declaring one as `client.agent`, would let an outside runner or a
 * person pass as the nest itself — so the webhook save is refused, a declared
 * reserved agent is stored as the person's own message, and none of them is
 * ever listed as a known agent.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(["hootie", "nest", "channel", "here", "everyone"]);

/** The handle Hootie's own messages carry. */
export const HOOTIE_HANDLE = "hootie";

/** The @names that address Hootie in a conversation. */
export const HOOTIE_ALIASES: ReadonlySet<string> = new Set(["hootie", "nest"]);

export function isReservedHandle(raw: unknown): boolean {
  return RESERVED_HANDLES.has(String(raw ?? "").trim().replace(/^@/, "").toLowerCase());
}

/**
 * Keys only the server writes into a message's stored attribution: the marks
 * the timeline reads back as `model_answer`, `citations`, `proposal`, … A
 * caller-supplied `client` must never carry them, or a person could post text
 * that renders as Hootie's answer, a proposal card or a handoff.
 */
export const SERVER_CLIENT_KEYS: ReadonlySet<string> = new Set([
  "model_answer",
  "for",
  "citations",
  "proposal",
  "proposal_outcome",
  "handoff",
  "handoff_update",
]);
