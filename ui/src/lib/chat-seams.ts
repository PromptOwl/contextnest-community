/**
 * Seams for the slices built in parallel with the harness (PO-1200,
 * AC-C3-12). Each is a typed hook with the shape its section will read; until
 * that slice's server contract lands on this base the hook answers
 * `available: false` and the section stays out of the DOM. Nothing here calls
 * the server, so nothing is faked: a section appears only once its hook is
 * wired to real routes.
 *
 * C2 (conversations and live) is built for real (lib/chat-live.ts,
 * lib/chat-harness.ts). C6 and C7 have their server on this base; their
 * screens are slice C9, so these stay seams here:
 *
 *  - C6 memory snowball: thread↔node relations, decision ledger
 *  - C7 the nest in the conversation: proposal cards, agent profiles
 */

export type Seam<T> = { available: false } | ({ available: true } & T);

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
