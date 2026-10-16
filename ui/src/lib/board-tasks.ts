/**
 * Board card logic for project work — pure, so it runs in the node test env
 * (test/board-tasks.test.ts). MaturityBoard renders; this decides.
 *
 * The patterns are borrowed, not invented: Linear's four priorities and bar
 * icons, Trello's overdue-red due chip, Jira/ClickUp's avatar quick-filter.
 */
import { saveOutcome } from "./save-outcome";
import type { BoardNode } from "./board-dimensions";

export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Sort weight: urgent first, no priority last. */
export function priorityRank(p: string | undefined): number {
  const i = (PRIORITIES as readonly string[]).indexOf(p ?? "");
  return i === -1 ? PRIORITIES.length : i;
}

export type DueState = "overdue" | "today" | "soon" | "later";

/** `due` is a calendar day (YYYY-MM-DD); `today` likewise, in the viewer's
 *  zone — compared as strings/days so no timezone shifts a deadline. */
export function dueState(due: string, today: string): DueState {
  if (due < today) return "overdue";
  if (due === today) return "today";
  const days = (Date.parse(due) - Date.parse(today)) / 86_400_000;
  return days <= 2 ? "soon" : "later";
}

/** Today as YYYY-MM-DD in the viewer's local zone. */
export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "Oct 31" — the year only when it isn't this year. */
export function formatDue(due: string, today: string): string {
  const [y, m, d] = due.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(due.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}),
  });
}

/** The quick-filter's key for cards with nobody on them. */
export const UNASSIGNED = "__unassigned__";

/** Empty selection = no filter. Otherwise a card shows when its assignee (or
 *  UNASSIGNED) is selected — selections OR together, as in Jira. */
export function matchesAssigneeFilter(node: BoardNode, selected: ReadonlySet<string>): boolean {
  if (selected.size === 0) return true;
  return selected.has(node.assignee ? node.assignee.toLowerCase() : UNASSIGNED);
}

/** Everyone holding at least one card, most cards first — the avatar row. */
export function assigneesOnBoard(nodes: BoardNode[]): string[] {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (!n.assignee) continue;
    const e = n.assignee.toLowerCase();
    counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([e]) => e);
}

/**
 * Open blockers to badge on a card: the server's count of `blocks` relations
 * from nodes outside a done column. A card that is itself done shows no badge —
 * what blocked it no longer matters. 0 = not blocked.
 */
export function openBlockers(
  node: Pick<BoardNode, "open_blockers" | "completed_at">,
): number {
  if (node.completed_at) return 0;
  const n = Number(node.open_blockers ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The board's "Hide blocked" quick filter. */
export function matchesBlockedFilter(
  node: Pick<BoardNode, "open_blockers" | "completed_at">,
  hideBlocked: boolean,
): boolean {
  return !hideBlocked || openBlockers(node) === 0;
}

/** Parent id → its sub-items, for the card's sub-item chip. */
export function subItemsByParent(nodes: BoardNode[]): Map<string, BoardNode[]> {
  const out = new Map<string, BoardNode[]>();
  for (const n of nodes) {
    if (!n.parent) continue;
    const list = out.get(n.parent) ?? [];
    list.push(n);
    out.set(n.parent, list);
  }
  return out;
}

export interface GovernanceContext {
  stewardshipEnabled: boolean;
  primeOnlyReview: boolean;
  allowSelfApprove: boolean;
  ownerOrAdmin: boolean;
  /** The nest's prime tags, bare and lower-cased. */
  primeTags: string[];
}

/**
 * Would dragging this card land as a draft that waits for review? Same rules
 * as the editor's Save button (save-outcome), which mirrors the server's
 * autoPublishReason. The server stays the authority; this only decides
 * whether to warn first.
 */
export function moveNeedsReview(node: BoardNode, g: GovernanceContext): boolean {
  const primeByTag =
    g.primeTags.length > 0 &&
    node.tags.some((t) => g.primeTags.includes(t.replace(/^#+/, "").toLowerCase()));
  return (
    saveOutcome({
      isNew: false,
      isOwnPendingReview: false,
      stewardshipEnabled: g.stewardshipEnabled,
      prime: node.prime ?? primeByTag,
      primeOnlyReview: g.primeOnlyReview,
      creatorIsReviewer: false,
      allowSelfApprove: g.allowSelfApprove,
      ownerOrAdmin: g.ownerOrAdmin,
      isTask: node.type === "task",
    }) === "draft"
  );
}

/** Multi-line tooltip of every timestamp a card has, oldest first. */
export function timestampsTooltip(
  n: Pick<BoardNode, "created_at" | "updated_at" | "assigned_at" | "moved_at" | "assignee">,
  fmt: (iso: string) => string,
): string {
  const lines: string[] = [];
  if (n.created_at) lines.push(`Created ${fmt(n.created_at)}`);
  if (n.assigned_at && n.assignee) lines.push(`Assigned to ${n.assignee} ${fmt(n.assigned_at)}`);
  if (n.moved_at) lines.push(`Moved ${fmt(n.moved_at)}`);
  if (n.updated_at) lines.push(`Updated ${fmt(n.updated_at)}`);
  return lines.join("\n");
}
