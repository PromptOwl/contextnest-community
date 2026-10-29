/**
 * Nest Overview — pure logic for the nest's landing page, kept out of the
 * component so it is testable in the node env.
 */
import { byPathSegments } from "../components/nest/node-display";

export interface FolderGroup<T> {
  /** Full folder path under nodes/ ("guides/engineering"); "Root" for loose docs. */
  folder: string;
  /** 0 for Root, else the number of path segments. */
  depth: number;
  items: T[];
}

/**
 * Folder → documents groups for the Overview index and the reader nav
 * (CU-wdqcpztgwp). Groups by the FULL folder path (everything before the
 * leaf), not just the first segment, so nested folders like nodes/gtm/deals
 * each get their own group. Root first, then segment-by-segment path order so
 * children sit right under their parent; documents by title within a folder.
 */
export function groupNodesByFolder<T extends { id?: string; title?: string }>(nodes: T[]): FolderGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const n of nodes) {
    const id: string = n.id || "";
    // Strip the "nodes/" storage root — it's not a user folder. What's left
    // is the real folder path; a doc directly under nodes/ has none → Root.
    const rel = id.startsWith("nodes/") ? id.slice(6) : id;
    const slash = rel.lastIndexOf("/");
    const folder = slash > 0 ? rel.slice(0, slash) : "Root";
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder)!.push(n);
  }
  return [...groups.entries()]
    .map(([folder, items]) => ({
      folder,
      depth: folder === "Root" ? 0 : folder.split("/").length,
      items: [...items].sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id))),
    }))
    .sort((a, b) => (a.folder === "Root" ? -1 : b.folder === "Root" ? 1 : byPathSegments(a.folder, b.folder)));
}

export interface OverviewFact {
  key: string;
  text: string;
  /** Status dot, in the reader's provenance colours: ok = emerald, warn = amber. */
  tone?: "ok" | "warn";
  /** The fact opens something — "review" jumps to the Review Queue tab. */
  action?: "review";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The one-line summary under the Overview heading — the facts the old stat
 * cards and tiles carried, written the way the reader writes a page's
 * provenance. The document count always shows; any other zero is dropped
 * (a row of zeros is noise). Governance facts only on a governed nest.
 */
export function overviewFacts(input: {
  total: number;
  folderCount: number;
  editedThisWeek: number;
  governance?: { pending: number; approved: number; reviewable: number };
}): OverviewFact[] {
  const facts: OverviewFact[] = [{ key: "documents", text: plural(input.total, "document") }];
  if (input.folderCount > 0) facts.push({ key: "folders", text: plural(input.folderCount, "folder") });
  if (input.editedThisWeek > 0) facts.push({ key: "edited", text: `${input.editedThisWeek} edited this week` });
  const g = input.governance;
  if (g) {
    // The green dot only on a real count — "0 AI ready" must not look healthy.
    facts.push({ key: "ai-ready", text: `${g.approved} AI ready`, ...(g.approved > 0 ? { tone: "ok" as const } : {}) });
    // Opens the queue too — a count you can't click reads as a dead end (CU-wdqcq04wnu).
    if (g.pending > 0) facts.push({ key: "pending", text: `${g.pending} pending review`, tone: "warn", action: "review" });
    if (g.reviewable > 0) facts.push({ key: "review", text: `${g.reviewable} waiting on your review`, action: "review" });
  }
  return facts;
}

/**
 * Why pending reviews aren't in the caller's queue, in plain words — the old
 * "N outside your scope" told an author nothing (CU-wdqcq02t1r). `ownBlocked`
 * is the caller's own submissions they may not approve (separation of duties).
 */
export function queueBreakdown(input: { pending: number; reviewable: number; ownBlocked: number }): string | null {
  const others = Math.max(0, input.pending - input.reviewable - input.ownBlocked);
  const parts: string[] = [];
  if (input.ownBlocked > 0) {
    parts.push(`${input.ownBlocked} you submitted — someone else must approve ${input.ownBlocked === 1 ? "it" : "them"}`);
  }
  if (others > 0) parts.push(`${others} assigned to other reviewers`);
  return parts.length ? parts.join(" · ") : null;
}

export type EmptyStateAction = "new" | "import" | "ai";

/**
 * The start actions an empty nest offers, each on the same gate as its
 * counterpart in the nest header: New document and Import need edit rights
 * (Import also needs the menu to exist), Add with AI follows the header's
 * own `!isReadOnly` gate so the two entry points never disagree.
 */
export function emptyStateActions(input: { canWrite: boolean; canImport: boolean; canAddWithAI: boolean }): EmptyStateAction[] {
  const actions: EmptyStateAction[] = [];
  if (input.canWrite) actions.push("new");
  if (input.canWrite && input.canImport) actions.push("import");
  if (input.canAddWithAI) actions.push("ai");
  return actions;
}

/**
 * Whether a folder row is collapsed — the index's and the reader nav's rule:
 * closed until opened, so a large folder never floods the tree on arrival
 * (CU-wdqcpzy9ac). A click wins either way.
 */
export function folderCollapsed(path: string, overrides: Map<string, boolean>): boolean {
  return overrides.get(path) ?? true;
}

/** Marker row that stands in for a folder's documents past the cap. */
export interface MoreMarker {
  id: string;
  more: { folder: string; hidden: number; total: number };
}

/**
 * First `max` documents per folder, then a single "more" marker (rendered as
 * "View all N"). The loose root documents are never capped — they are the
 * top of the index. Returns new groups; the input is not touched.
 */
export function capFolderDocs<G extends { folder: string; items: any[] }>(groups: G[], max: number): G[] {
  return groups.map((g) => {
    if (g.folder === "Root" || g.items.length <= max) return g;
    const marker: MoreMarker = {
      id: `more:${g.folder}`,
      more: { folder: g.folder, hidden: g.items.length - max, total: g.items.length },
    };
    return { ...g, items: [...g.items.slice(0, max), marker] };
  });
}
