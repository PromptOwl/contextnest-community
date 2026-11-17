/**
 * Who owns an @handle that names no person — the ONE seam between My Work's
 * mentions (PO-1180) and agent identity.
 *
 * Today an agent has no principal: it writes under a human login, and "@grok"
 * in a channel resolves to no account. The mention index (mention-index.ts)
 * still records such a handle, with `mentioned_user_id` NULL, keyed on the
 * handle string. This module answers the read-side question "which of those
 * handles belong to this caller's agents?", so those threads land in the
 * owner's My Work (`for_agent` names the agent).
 *
 * Until agent principals ship, nobody owns a handle: the default resolver
 * returns []. The identity work replaces `defaultResolver` below with a lookup
 * of the agents the caller owns (or registers one through
 * `setAgentMentionResolver` at startup) — nothing else changes. When it does,
 * an agent that is resolvable as an account at write time stops producing
 * NULL-user rows on its own, because the index resolves names through the
 * nest roster first.
 *
 * Whatever a resolver returns only ever WIDENS which handles match; every row
 * is still filtered to nests and nodes the caller can read (my-work.ts), so a
 * wrong or hostile answer here cannot reveal a thread the caller couldn't
 * open anyway (SEC-1).
 */

export interface AgentMentionCaller {
  userId: string;
  email: string;
}

/** Lowercased handles (no "@") of the agents this caller owns. */
export type AgentMentionResolver = (caller: AgentMentionCaller) => Promise<string[]>;

const defaultResolver: AgentMentionResolver = async () => [];

let resolver: AgentMentionResolver = defaultResolver;

/** Install the identity layer's resolver; null restores the default. */
export function setAgentMentionResolver(fn: AgentMentionResolver | null): void {
  resolver = fn ?? defaultResolver;
}

/**
 * The agent handles whose mentions roll up to this caller. Best-effort: a
 * failing resolver means "no agent mentions", never a failed My Work.
 */
export async function agentHandlesOwnedBy(caller: AgentMentionCaller): Promise<string[]> {
  try {
    const out = await resolver(caller);
    return [...new Set((out ?? []).map((h) => String(h).trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
  } catch (err) {
    console.error("[mentions] agent handle resolver failed", err);
    return [];
  }
}
