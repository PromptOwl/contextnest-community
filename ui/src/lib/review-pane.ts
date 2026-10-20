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

/** Only priorities that change what a reviewer does next get a badge. */
export function showPriorityBadge(priority: string): boolean {
  return priority === "high" || priority === "urgent";
}

/** Request changes sends the work back, so the author needs to know why. */
export function requestChangesError(note: string): string | null {
  return note.trim() ? null : "Add a reason so the author knows what to change.";
}

/** Why the pane is read-only for this caller, or null when they can decide.
 *  `canReview` is server-computed; an older server that omits it only lists
 *  reviewable items, so a missing flag means reviewable. */
export function readOnlyReason(
  request: { canReview?: boolean; requestedBy: string },
  currentUser: string | null | undefined,
): string | null {
  if (request.canReview !== false) return null;
  if (currentUser && request.requestedBy === currentUser) {
    return "You submitted this change, so someone else has to review it (separation of duties).";
  }
  return "This change is outside your steward scope, so you can read it but not approve it.";
}
