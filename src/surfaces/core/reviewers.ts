/**
 * Reviewer eligibility for routing (§4.8, N4) — the S1 part. Eligible =
 * approvers (users passing canUserApprove, resolved by the caller) who map
 * to a current member of the source conversation. No eligible reviewer →
 * the proposal is held.
 *
 * Under the subset rule every reader is a member, and every approver is a
 * reader, so an eligible reviewer is always present: hold happens only after
 * an explicit org-public bind, or when the nest has no approver at all.
 */
export type RouteResult = { outcome: "eligible"; reviewers: string[] } | { outcome: "hold"; reason: "no_approver" | "none_in_conversation" };

export function routeReviewer(input: {
  captureBasis: "subset" | "org_public";
  approvers: string[];
  memberUserIds: string[];
}): RouteResult {
  if (input.approvers.length === 0) return { outcome: "hold", reason: "no_approver" };
  const members = new Set(input.memberUserIds);
  const reviewers = input.approvers.filter((u) => members.has(u));
  if (reviewers.length === 0) return { outcome: "hold", reason: "none_in_conversation" };
  return { outcome: "eligible", reviewers };
}

// ─── S2b: ranking (§4.8) and who an ephemeral may name (N6) ────────────────

export interface ReviewerStats {
  userId: string;
  /** Pending items currently named to this reviewer (posted or queued). */
  pending: number;
  /** ISO time this reviewer was last named on a card; null = never. */
  lastNamedAt: string | null;
  /** Cards already posted to this reviewer today (org day). */
  usedToday: number;
}

/**
 * The §4.8 order: folder owner first (when folder ownership exists — V15:
 * Community has no folder owners, so the service passes none), then fewest
 * pending, then least recently named (never named first). Ties keep the
 * input order, so the result is deterministic.
 */
export function rankReviewers(eligible: ReviewerStats[], folderOwners: ReadonlySet<string> = new Set()): ReviewerStats[] {
  return eligible
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const fo = Number(folderOwners.has(b.r.userId)) - Number(folderOwners.has(a.r.userId));
      if (fo) return fo;
      if (a.r.pending !== b.r.pending) return a.r.pending - b.r.pending;
      const la = a.r.lastNamedAt ? Date.parse(a.r.lastNamedAt) : -Infinity;
      const lb = b.r.lastNamedAt ? Date.parse(b.r.lastNamedAt) : -Infinity;
      if (la !== lb) return la - lb;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/**
 * N6: the only people a "who can approve" note may name are eligible
 * reviewers who are current members of THIS conversation. Absent reviewers
 * are never named.
 */
export function nameableReviewers(eligibleUserIds: string[], conversationMemberUserIds: string[]): string[] {
  const here = new Set(conversationMemberUserIds);
  return [...new Set(eligibleUserIds)].filter((u) => here.has(u));
}
