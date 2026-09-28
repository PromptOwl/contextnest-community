/** Small display helpers shared by the nest tabs. */
import { parseServerDate } from "../../lib/dates";

export function timeAgo(dateStr: string) {
  // See lib/dates — SQL-default timestamps carry no zone.
  const date = parseServerDate(dateStr);
  if (!date) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The chip a non-document node type shows in a row; null for documents. */
export function typePill(t: string): { label: string; cls: string; title: string } | null {
  switch (t) {
    case "artifact":
      return {
        label: "HTML",
        title: "Hosted HTML artifact",
        cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
      };
    case "agent":
      return {
        label: "Agent",
        title: "Runnable agent node",
        cls: "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
      };
    case "skill":
      return {
        label: "Skill",
        title: "Runnable skill node",
        cls: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
      };
    default:
      return null;
  }
}

/** Compare paths segment-by-segment (not as flat strings) so children always
 *  sort directly under their parent — a sibling like "nodes-extra" would
 *  otherwise wedge between "nodes" and "nodes/a". */
export function byPathSegments(a: string, b: string) {
  const as = a.split("/");
  const bs = b.split("/");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const cmp = as[i].localeCompare(bs[i]);
    if (cmp !== 0) return cmp;
  }
  return as.length - bs.length;
}

/** Folder path of a node id ("" for docs directly under nodes/). */
export function folderOfNode(id: string): string {
  const rel = id.startsWith("nodes/") ? id.slice(6) : id;
  const slash = rel.lastIndexOf("/");
  return slash > 0 ? rel.slice(0, slash) : "";
}

/** Human-readable labels for the document filters and chips. */
export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_review: "Pending",
  published: "Published",
  rejected: "Rejected",
};
export const DATE_LABELS: Record<string, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "1y": "Last year",
};
export const TYPE_LABELS: Record<string, string> = {
  document: "Document",
  artifact: "Artifact",
  agent: "Agent",
  skill: "Skill",
  tool: "Tool",
  table: "Table",
};
