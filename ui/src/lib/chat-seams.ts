/**
 * Seams for the slices built in parallel with the harness (PO-1200,
 * AC-C3-12). Each is a typed hook with the shape its section will read; until
 * that slice's server contract lands on this base the hook answers
 * `available: false` and the section stays out of the DOM. Nothing here calls
 * the server, so nothing is faked: a section appears only once its hook is
 * wired to real routes.
 *
 *  - C2 conversations and live: direct messages, presence, typing, the toggle
 *  - C6 memory snowball: thread↔node relations, decision ledger
 *  - C7 the nest in the conversation: proposal cards, agent profiles
 */

export interface DirectConversation {
  id: string;
  title: string;
  unread: number;
  last_activity_at: string | null;
}

export type Seam<T> = { available: false } | ({ available: true } & T);

/** C2: the caller's direct and group messages in this nest. */
export function useDirectMessages(_nestId: string): Seam<{ conversations: DirectConversation[] }> {
  return { available: false };
}

export interface PresenceState {
  /** Who is here now, by login. */
  online: Set<string>;
  /** Who is typing in the open conversation, by display name. */
  typing: string[];
}

/** C2: presence and typing for a conversation. */
export function usePresence(_nestId: string, _conversation: string | null): Seam<PresenceState> {
  return { available: false };
}

export interface ThreadRelation {
  node_id: string;
  title: string;
  relation: string;
}

/** C6: what the nest remembers from this thread (relations, decisions). */
export function useThreadMemory(_nestId: string, _threadId: string | null): Seam<{ relations: ThreadRelation[] }> {
  return { available: false };
}

export interface ProposalCard {
  id: string;
  title: string;
  summary: string;
  status: "open" | "approved" | "rejected";
}

/** C7: proposals an agent made in this thread, approvable inline. */
export function useProposals(_nestId: string, _threadId: string | null): Seam<{ proposals: ProposalCard[] }> {
  return { available: false };
}
