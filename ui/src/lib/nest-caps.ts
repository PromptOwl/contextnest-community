/**
 * Nest capability flags, derived in one place from what GET /nests/:id returns.
 *
 * Pulled out of NestView so other nest-scoped views (the board, and anything
 * added later) gate on the same rule instead of re-deriving it. Coarse UI
 * gating only — the server still enforces per node, so a mistake here is a
 * confusing affordance, not a security hole.
 */

/** The slice of a steward row the rules need. */
export interface CapSteward {
  role: string;
  scope: string;
}

export interface NestCapsInput {
  /** Caller's merged effective roles (collaborator + steward), nest-wide. */
  roles: string[];
  /** Caller's nest-level collaborator permission. */
  permission: string | null;
  /** Caller's own scoped steward rows. */
  myStewards: CapSteward[];
  isOwner: boolean;
  isAdmin: boolean;
  /**
   * Whether Public Docs Reader Mode is enabled on the nest (nest.reader_mode).
   * Only flips the presentation for read-only callers — owners/editors/admins
   * keep the full authoring UI.
   */
  readerMode?: boolean;
}

export interface NestCaps {
  /** Assign stewards + share with collaborators (owner/admin). */
  canManage: boolean;
  /** Nest-wide write via a collaborator grant. */
  collabCanWrite: boolean;
  /** Approve/reject (owner/admin or reviewer steward). */
  canReviewDocs: boolean;
  /** Create/edit documents (nest-wide write or nest-scope editor). */
  canEditDocs: boolean;
  /** No write/review/manage — public visitors and plain 'read' collaborators. */
  isReadOnly: boolean;
  /**
   * Show the stripped read-only Public Docs Reader presentation. True ONLY when
   * the nest has reader mode on AND the caller is read-only — owners, editors,
   * reviewers and admins keep the full tabbed authoring UI.
   */
  isReaderView: boolean;
}

export function deriveNestCaps({
  roles,
  permission,
  myStewards,
  isOwner,
  isAdmin,
  readerMode,
}: NestCapsInput): NestCaps {
  const hasRole = (...r: string[]) => roles.some((x) => r.includes(x));
  const canManage = isOwner || isAdmin || hasRole("owner", "admin");
  const collabCanWrite =
    permission === "owner" || permission === "admin" || permission === "write";
  const canReviewDocs =
    canManage || myStewards.some((s) => s.role === "reviewer");
  const canEditDocs =
    canManage ||
    collabCanWrite ||
    myStewards.some((s) => s.role === "editor" && s.scope === "nest");
  const isReadOnly = !canEditDocs && !canReviewDocs && !canManage;
  const isReaderView = !!readerMode && isReadOnly;
  return {
    canManage,
    collabCanWrite,
    canReviewDocs,
    canEditDocs,
    isReadOnly,
    isReaderView,
  };
}


/** Lowercased leaf of a node id — "nodes/guides/Welcome" → "welcome". */
function leafOf(id: string): string {
  const path = id.startsWith("nodes/") ? id.slice(6) : id;
  const leaf = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  return leaf.toLowerCase();
}

/**
 * Whether a node is the designated reader-mode home node. Ids are
 * `nodes/<slug>` but the config field is typed by hand, so match on the leaf
 * either way — otherwise "welcome" silently misses `nodes/welcome` and the
 * convention fallback quietly stands in for the designation. Shared by
 * ReaderView (resolving the home pane) and NestView (validating before save).
 */
export function isHomeNode(node: any, homeNode: string): boolean {
  return node?.id === homeNode || leafOf(node?.id || "") === leafOf(homeNode);
}

/**
 * Node id/title keys matched against the home-node naming convention when no
 * home node is designated.
 */
export function conventionKey(node: any): string[] {
  return [leafOf(node?.id || ""), String(node?.title || "").toLowerCase()];
}

/**
 * Shell nest-view tabs hidden by Public Docs Reader Mode — the board, ontology
 * graph and definitions authoring surfaces. In reader mode a public reader sees
 * only the docs, so these disappear from the nest view switcher.
 */
export const READER_HIDDEN_VIEWS = [
  "board",
  "ontology-graph",
  "definitions",
] as const;

/** Whether a nest-view page is hidden when reader mode is active for a reader. */
export function isReaderHiddenView(page: string): boolean {
  return (READER_HIDDEN_VIEWS as readonly string[]).includes(page);
}

/**
 * Whether a nest-scoped page must be BLOCKED for the current caller — true only
 * when the caller is in reader mode AND the page is one reader mode hides.
 *
 * Single source of truth for every reader-mode page gate: the deep-link probe
 * (so `?view=board` can't enter the page), the top-level redirect effect, and
 * the render conditionals. The board / ontology-graph / definitions pages are
 * top-level `view.page` states rendered independently of the (already hidden)
 * tab buttons, so hiding the tab alone did not stop a read-only caller from
 * reaching the full authoring page by URL.
 */
export function isViewBlockedInReaderMode(
  page: string,
  readerMode: boolean | undefined,
): boolean {
  return !!readerMode && isReaderHiddenView(page);
}
