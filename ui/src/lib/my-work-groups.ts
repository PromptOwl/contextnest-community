import type { AssignedItem, WorkItem, WorkPagination } from "./api";

/**
 * Split the inbox: reviews (the only rows a batch decision applies to) and
 * requests (deletion / archive / access), which are decided one at a time and so list
 * after the reviews under their own header.
 */
export function splitWorkItems(items: WorkItem[]) {
  return {
    reviews: items.filter((w) => w.type === "review"),
    requests: items.filter((w) => w.type !== "review"),
  };
}

/**
 * A row's identity in the inbox. Reviews and deletion flags are one per
 * document, so the document names them; an access request isn't — two people
 * can ask about the same document, and a review can sit on it too — so it is
 * named by its own request id.
 */
export function workItemKey(w: WorkItem): string {
  return w.type === "access" && w.request_id
    ? `access:${w.request_id}`
    : `${w.nest_id}:${w.node_id}`;
}

/**
 * The My Work badge: everything waiting on you — the reviews and requests the
 * server totals, plus the open tasks assigned to you. Assigned tasks aren't in
 * pagination.total because they don't page with the reviews. Unread
 * notifications (comments, mentions, watched documents) count too — /me/work
 * carries them whatever the page size.
 */
export function waitingOnMeCount(
  work: { pagination?: WorkPagination; assigned?: AssignedItem[]; notifications?: unknown[] } | undefined,
): number {
  return (work?.pagination?.total ?? 0) + (work?.assigned?.length ?? 0) + (work?.notifications?.length ?? 0);
}

/** "All caught up" only when no review, request or assigned task waits on you. */
export function nothingWaitingOnMe(work: { items: WorkItem[]; assigned?: AssignedItem[] }): boolean {
  return work.items.length === 0 && (work.assigned?.length ?? 0) === 0;
}
