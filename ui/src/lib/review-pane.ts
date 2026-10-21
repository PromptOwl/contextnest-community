/**
 * Pure rules for the Review tab's side-by-side review pane (CU-wdqcq05mhk).
 * Framework-free so they stay unit-testable without a DOM.
 */

export type ReviewPaneTab = "preview" | "changes" | "published";

/** The review open in the pane, from `?review=<nodeId>` — a shareable link. */
export function reviewIdFromSearch(search: string): string | null {
  return new URLSearchParams(search).get("review");
}

/** The search string with `review` set, or removed when nothing is open. */
export function withReviewParam(search: string, nodeId: string | null): string {
  const p = new URLSearchParams(search);
  if (nodeId) p.set("review", nodeId);
  else p.delete("review");
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Changes first when there is a different published version to compare
 *  against; a first version has nothing to diff, so it opens on Preview. */
export function defaultReviewTab(v: {
  approvedVersion: number | null | undefined;
  pendingVersion: number | null | undefined;
}): ReviewPaneTab {
  return v.approvedVersion != null && v.approvedVersion !== v.pendingVersion
    ? "changes"
    : "preview";
}

/** After a decision, the item to open next: the one after the decided item,
 *  else the one before it, else nothing. When the decided item has already
 *  left the queue (a refetch beat us), start from the top. */
export function nextReviewNodeId(
  queue: ReadonlyArray<{ nodeId: string }>,
  decidedNodeId: string,
): string | null {
  const i = queue.findIndex((r) => r.nodeId === decidedNodeId);
  if (i === -1) return queue[0]?.nodeId ?? null;
  return queue[i + 1]?.nodeId ?? queue[i - 1]?.nodeId ?? null;
}

/** The changes in the order the queue shows them, so "next" is the row the
 *  reviewer sees below. The feed views list newest first (same tie-break as
 *  the server's feed merge); the Changes chip keeps the server's order. */
export function displayedChangeOrder<T extends { id: string; requestedAt: string }>(
  queue: ReadonlyArray<T>,
  feedMode: boolean,
): T[] {
  if (!feedMode) return [...queue];
  return [...queue].sort(
    (a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id),
  );
}

/** Only priorities that change what a reviewer does next get a badge. */
export function showPriorityBadge(priority: string): boolean {
  return priority === "high" || priority === "urgent";
}

/** Request changes sends the work back, so the author needs to know why. */
export function requestChangesError(note: string): string | null {
  return note.trim() ? null : "Add a reason so the author knows what to change.";
}

/** The caller's steward rows on this document are only reviewer/viewer, so
 *  they approve but never author it (the editor's isReviewerOnly rule). */
export function isReviewerOnly(
  stewards: ReadonlyArray<{ email?: string; role: string }>,
  currentUser: string | null | undefined,
): boolean {
  const me = (currentUser ?? "").toLowerCase();
  const roles = stewards.filter((s) => (s.email ?? "").toLowerCase() === me).map((s) => s.role);
  return roles.length > 0 && !roles.some((r) => r === "editor" || r === "admin");
}

/** Why the pane is read-only for this caller, or null when they can decide.
 *  `canReview` is server-computed; an older server that omits it only lists
 *  reviewable items, so a missing flag means reviewable. */
export function readOnlyReason(
  request: { canReview?: boolean; requestedBy: string },
  currentUser: string | null | undefined,
): string | null {
  if (request.canReview !== false) return null;
  if (currentUser && request.requestedBy.toLowerCase() === currentUser.toLowerCase()) {
    return "You submitted this change, so someone else has to review it (separation of duties).";
  }
  return "This change is outside your steward scope, so you can read it but not approve it.";
}
