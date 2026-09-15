/**
 * Document page chrome rules — the pure half of the Notion-style document
 * layout (sidebar tree + top bar + collapsible comments rail). Kept out of
 * the components so the rules are testable without a DOM.
 */

/** Node id → folder path relative to `nodes/` ("" for a loose root doc). */
export function folderOfNodeId(id: string): string {
  const rel = id.startsWith("nodes/") ? id.slice(6) : id;
  const segs = rel.split("/");
  return segs.slice(0, -1).join("/");
}

/** Every folder on the way to a document — "a/b/c/doc" → ["a", "a/b", "a/b/c"].
 *  The sidebar opens these so the current document is visible on arrival. */
export function folderAncestors(nodeId: string): string[] {
  if (nodeId === "new") return [];
  const folder = folderOfNodeId(nodeId);
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
    const folder = folderOfNodeId(n.id);
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
}

export const DOC_PAGE_PREFS_KEY = "contextnest:doc-page";

const DEFAULT_PREFS: DocPagePrefs = { sidebarCollapsed: false, commentsOpen: false };

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
