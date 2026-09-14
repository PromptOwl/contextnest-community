/**
 * Who may do what in the document editor.
 *
 * Four signals decide it, and none of them alone is the answer: the caller's
 * nest-level permission, their nest-scoped steward rows, their steward rows
 * resolved for THIS node (stewardship resolves document → tag → nest), and any
 * share grant on the document. Kept here as plain functions because the editor
 * gates a dozen affordances on them and the rules are easy to get subtly wrong
 * — a viewer seeing the tag input, or an editor steward locked out of a nest
 * they only read.
 */

export interface EditorAccessInput {
  /** Authoring a document that doesn't exist yet (no node to resolve against). */
  isNew: boolean;
  /** Nest owner. */
  isOwner: boolean;
  /** Server admin (super admin), independent of this nest. */
  isAdmin: boolean;
  /** Nest-level permission from GET /nests/:id — null until it loads. */
  permission: string | null;
  /** Caller's nest-wide steward rows. */
  nestStewards: Array<{ role: string; scope: string }>;
  /** Caller's steward roles resolved for this node. */
  nodeRoles: string[];
  /** Caller's share grant on this document, if any. */
  grant: "read" | "write" | null;
  /** Nest is archived — forces read-only regardless of role, mirroring
   *  deriveNestCaps' early return in lib/nest-caps. */
  isArchived?: boolean;
}

export interface EditorAccess {
  canAuthorNew: boolean;
  hasAdminApprove: boolean;
  isViewOnly: boolean;
  isReviewerOnly: boolean;
  canEditContent: boolean;
}

export function resolveEditorAccess(input: EditorAccessInput): EditorAccess {
  const {
    isNew,
    isOwner,
    isAdmin,
    permission,
    nestStewards,
    nodeRoles,
    grant,
    isArchived,
  } = input;

  // A NEW doc has no node to resolve a per-node role against, so this gates on
  // nest-wide capability only. Mirrors NestView's "New Document" gate.
  const canAuthorNew =
    isOwner ||
    isAdmin ||
    permission === "owner" ||
    permission === "admin" ||
    permission === "write" ||
    nestStewards.some((s) => s.role === "editor" && s.scope === "nest");

  const hasAdminApprove =
    isAdmin || permission === "admin" || nodeRoles.includes("admin");
  // Stewardship resolves document → tag → nest, so an editor (or admin)
  // steward scoped to THIS node edits a nest they only read at nest level.
  const hasNodeEditRole =
    nodeRoles.includes("editor") || nodeRoles.includes("admin");

  // Stated as "who may edit", not "who is read-only". Keyed the other way
  // round — off permission === 'read' — an unresolved (or "none") permission
  // opened the authoring UI to someone the server would 403.
  // Archived overrides every other signal, same as deriveNestCaps: an owner
  // or admin caretaker reopening an archived nest to consider restoring it
  // still can't save, so the editor must not offer to.
  const isViewOnly = isArchived
    ? true
    : isNew
      ? !canAuthorNew
      : !(canAuthorNew || grant === "write" || hasNodeEditRole);

  // Read-only when the caller's only steward rows are reviewer/viewer: editors
  // author, reviewers approve, viewers read. Editor + reviewer is NOT
  // reviewer-only, and neither is an admin row, which outranks both.
  const isReviewerOnly =
    !isOwner &&
    nodeRoles.length > 0 &&
    !nodeRoles.includes("editor") &&
    !hasAdminApprove;

  // Authoring controls (tag editor, type picker, the editing surface). Distinct
  // from isViewOnly: a reviewer or viewer steward can hold write access to the
  // nest — they may approve or comment here, never author.
  return {
    canAuthorNew,
    hasAdminApprove,
    isViewOnly,
    isReviewerOnly,
    canEditContent: !isViewOnly && !isReviewerOnly,
  };
}
