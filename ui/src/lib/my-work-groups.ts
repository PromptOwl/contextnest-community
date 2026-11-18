import type { AssignedItem, WorkItem, WorkPagination } from "./api";
import { dueState, localToday } from "./board-tasks";

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
 * carries them whatever the page size. What you handed off (Waiting on others)
 * needs nothing from you, so it stays out (CU-wdqcq0658p).
 */
export function waitingOnMeCount(
  work:
    | { waiting_on_me_total?: number; pagination?: WorkPagination; assigned?: AssignedItem[]; notifications?: unknown[] }
    | undefined,
): number {
  return (
    (work?.waiting_on_me_total ?? work?.pagination?.total ?? 0) +
    (work?.assigned?.length ?? 0) +
    (work?.notifications?.length ?? 0)
  );
}

/** "All caught up" only when no review, request or assigned task waits on you. */
export function nothingWaitingOnMe(work: { items: WorkItem[]; assigned?: AssignedItem[] }): boolean {
  return work.items.length === 0 && (work.assigned?.length ?? 0) === 0;
}

/**
 * How many of the things waiting on you are urgent — the My Work count turns
 * red when this is above zero. Urgent means: a review filed as urgent (the
 * server counts those), a task marked urgent, or a task past its due day.
 * Due days are compared in the viewer's own calendar day, so a deadline
 * never flips early or late with the server's time zone.
 */
export function urgentOnMeCount(
  work: { urgent_reviews_total?: number; assigned?: AssignedItem[] } | undefined,
  today: string = localToday(),
): number {
  const tasks = (work?.assigned ?? []).filter(
    (a) => a.priority === "urgent" || (!!a.due && dueState(a.due, today) === "overdue"),
  ).length;
  return (work?.urgent_reviews_total ?? 0) + tasks;
}
