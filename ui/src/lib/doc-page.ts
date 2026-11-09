/**
 * Document page chrome rules — the pure half of the Notion-style document
 * layout (sidebar tree + top bar + collapsible comments rail). Kept out of
 * the components so the rules are testable without a DOM.
 */
import type { LucideIcon } from "lucide-react";
import { folderOf } from "./board-dimensions";
import { visibleNestPages } from "./nest-pages";

/** Every folder on the way to a document — "a/b/c/doc" → ["a", "a/b", "a/b/c"].
 *  The sidebar opens these so the current document is visible on arrival. */
export function folderAncestors(nodeId: string): string[] {
  if (nodeId === "new") return [];
  const folder = folderOf(nodeId);
  if (!folder) return [];
  const segs = folder.split("/");
  return segs.map((_, i) => segs.slice(0, i + 1).join("/"));
}

/**
 * Group a flat node list into the `{ folder, items }` shape FolderTree takes,
 * folder derived from each id. Groups sort by folder path and docs by title,
 * so the tree reads like a file explorer regardless of server order.
 */
export function groupNodesByFolder<T extends { id: string; title?: string }>(
  nodes: T[],
): { folder: string; items: T[] }[] {
  const byFolder = new Map<string, T[]>();
  for (const n of nodes) {
    const folder = folderOf(n.id);
    const list = byFolder.get(folder);
    if (list) list.push(n);
    else byFolder.set(folder, [n]);
  }
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  return [...byFolder.entries()]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([folder, items]) => ({
      folder,
      items: [...items].sort((a, b) =>
        collator.compare(a.title ?? a.id, b.title ?? b.id),
      ),
    }));
}

/**
 * The comments rail starts closed (an empty panel beside every document is
 * dead space) but must never hide a thread the user is being pointed at:
 * a deep link to a thread, comment mode, pinning a comment to a selection,
 * or focusing a thread from a highlight in the body all open it.
 */
export function nextCommentsOpen(
  open: boolean,
  signals: {
    initialThreadId?: string | null;
    commentMode?: boolean;
    pendingAnchor?: boolean;
    activeThreadId?: string | null;
  },
): boolean {
  return (
    open ||
    !!signals.initialThreadId ||
    !!signals.commentMode ||
    !!signals.pendingAnchor ||
    !!signals.activeThreadId
  );
}

export interface DocPagePrefs {
  sidebarCollapsed: boolean;
  commentsOpen: boolean;
  /** The sidebar's "Views" group (board, graph, definitions, workflows). */
  viewsOpen: boolean;
  /** Dashboard rail groups the user folded (Work, Admin, …). Open by default. */
  closedGroups: string[];
}

export const DOC_PAGE_PREFS_KEY = "contextnest:doc-page";

const DEFAULT_PREFS: DocPagePrefs = {
  sidebarCollapsed: false,
  commentsOpen: false,
  viewsOpen: false,
  closedGroups: [],
};

type StorageLike = {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
};

/** Per-browser layout choices. Storage may be blocked (private window,
 *  quota) — a failure reads as the defaults and a write is dropped. */
export function readDocPagePrefs(storage: StorageLike): DocPagePrefs {
  try {
    const raw = storage.getItem(DOC_PAGE_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return {
      sidebarCollapsed:
        typeof parsed?.sidebarCollapsed === "boolean"
          ? parsed.sidebarCollapsed
          : DEFAULT_PREFS.sidebarCollapsed,
      commentsOpen:
        typeof parsed?.commentsOpen === "boolean"
          ? parsed.commentsOpen
          : DEFAULT_PREFS.commentsOpen,
      viewsOpen:
        typeof parsed?.viewsOpen === "boolean"
          ? parsed.viewsOpen
          : DEFAULT_PREFS.viewsOpen,
      closedGroups: Array.isArray(parsed?.closedGroups)
        ? parsed.closedGroups.filter((g: unknown) => typeof g === "string")
        : [...DEFAULT_PREFS.closedGroups],
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writeDocPagePrefs(
  storage: StorageLike,
  patch: Partial<DocPagePrefs>,
): void {
  try {
    const next = { ...readDocPagePrefs(storage), ...patch };
    storage.setItem(DOC_PAGE_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked — the choice just doesn't persist */
  }
}

export interface NestSidebarView {
  /** "overview" / "review" for the nest page's own tabs; a registry page id
   *  (its folder name under pages/nest) for the rest. */
  id: string;
  label: string;
  /** Registry pages bring their icon; the nest-page tabs have fixed ones. */
  icon?: LucideIcon;
  /** Top-level rows are the ones you act on daily; the rest fold under a
   *  collapsed "Views" group so the sidebar reads as nest → docs. */
  group?: "views";
  /** App view page to open. */
  page: "nest" | "board" | "ontology-graph" | "definitions" | "workflows" | "structure" | "channels";
  /** Nest-page tab, for views that are tabs of the nest page. */
  tab?: "overview" | "review";
}

/**
 * The nest's views listed under its name in the sidebar, so the review queue,
 * board and graph are one click from any document. Same gates as the nest
 * view switcher and NestView's tab strip: the review queue and workflows are
 * for people who can act in them, and a docs-site reader (reader mode) sees
 * none of the authoring surfaces.
 */
export function nestSidebarViews(
  caps: { isReadOnly: boolean; isReaderView: boolean; canEditDocs: boolean },
  opts: {
    workflowPlaneEnabled: boolean;
    /** Experimental channels switch (PO-1179). */
    agentStreamEnabled?: boolean;
    /** The caller is a person added to the nest (channels are members-only). */
    isMember?: boolean;
    /** The nest runs stewardship — the queue is a standing surface then. */
    stewardshipEnabled?: boolean;
    /** Something is already waiting (reviews, deletion flags) — the queue
     *  shows on an ungoverned nest too, same as NestView's tab. */
    hasPending?: boolean;
  },
): NestSidebarView[] {
  const views: NestSidebarView[] = [
    { id: "overview", label: "Overview", page: "nest", tab: "overview" },
  ];
  if (caps.isReaderView) return views;
  // Mirrors NestView's showReviewTab && !isReadOnly: an editor on an
  // ungoverned nest with nothing pending would otherwise get a row that
  // lands on the overview.
  if (!caps.isReadOnly && (opts.stewardshipEnabled || opts.hasPending))
    views.push({ id: "review", label: "Review queue", page: "nest", tab: "review" });
  // The registry pages, each gated by its own meta.visible (workflows: the
  // workflow-plane flag and write access).
  for (const p of visibleNestPages({ ...caps, workflowPlaneEnabled: opts.workflowPlaneEnabled, agentStreamEnabled: !!opts.agentStreamEnabled, isMember: opts.isMember === true }))
    views.push({ id: p.id, label: p.label, icon: p.icon, page: p.viewPage, group: "views" });
  return views;
}
