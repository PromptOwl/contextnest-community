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
