/**
 * Admin activity log helpers (CU-wdqcq03aw2) — labels and the menu gate, kept
 * pure so they're testable without rendering.
 */
import type { ActivityLogItem, ActivityLogType } from "./api";

/** Who sees "Activity" in a ⋯ menu: the nest owner and nest admins. The
 *  server enforces the same rule (403 for everyone else); this only decides
 *  whether to draw the entry. */
export function canSeeActivityLog(permission: string | null | undefined): boolean {
  return permission === "owner" || permission === "admin";
}

export const ACTIVITY_LABELS: Record<ActivityLogType, string> = {
  created: "created",
  edited: "edited",
  restored: "restored a version",
  review_requested: "requested review",
  approved: "approved",
  rejected: "rejected",
  review_cancelled: "cancelled review",
  commented: "commented",
  comment_resolved: "resolved a comment",
  deleted: "deleted",
  read: "read",
  retrieved: "pulled into a search / answer",
  exported: "exported",
};

/** Filter groups for the type picker. */
export const ACTIVITY_FILTERS: Array<{ id: string; label: string; types: ActivityLogType[] }> = [
  { id: "all", label: "Everything", types: [] },
  { id: "changes", label: "Changes", types: ["created", "edited", "restored", "deleted"] },
  { id: "reviews", label: "Reviews", types: ["review_requested", "approved", "rejected", "review_cancelled"] },
  { id: "comments", label: "Comments", types: ["commented", "comment_resolved"] },
  { id: "access", label: "Reads & pulls", types: ["read", "retrieved", "exported"] },
];

/** One line of the log: "alice@acme.com (via hootie) read". */
export function describeActivity(item: ActivityLogItem): string {
  const who = item.agent ? `${item.actor} (via ${item.agent})` : item.actor;
  const what =
    item.type === "exported" && item.nodeId === null
      ? "exported the whole nest"
      : ACTIVITY_LABELS[item.type] ?? item.type;
  const version = item.version != null && ["created", "edited", "restored"].includes(item.type)
    ? ` v${item.version}`
    : "";
  return `${who} ${what}${version}`;
}

/** "MCP" for ctx / agents, "web / API" for everything else. */
export function surfaceLabel(surface?: "api" | "mcp"): string | null {
  if (surface === "mcp") return "MCP";
  if (surface === "api") return "web / API";
  return null;
}
