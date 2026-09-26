/**
 * The document page's ⋮ overflow menu, as data.
 *
 * DocumentEditor (markdown) and ArtifactViewer (hosted HTML) both render this
 * list; each maps a `key` to its icon and handler. Keeping the gating here —
 * not inline in one component's JSX — is what stops the two surfaces from
 * drifting: the artifact viewer shipped for months with no Share / Publish /
 * Copy link because those lived only in the markdown editor's header
 * (CU-wdqcq02gy8). Rules are unit-tested in document-actions.test.ts.
 */

/**
 * A pdf node's binary is bound to its id (src/nodes/service.ts's moveNode
 * refuses it: "PDF documents can't be moved to another folder yet"). Shared
 * by this menu and the documents-list row menu/drag-drop so neither offers a
 * move that the server will always 409 on.
 */
export function nodeTypeSupportsMove(type: string | undefined): boolean {
  return type !== "pdf";
}

export type DocumentActionKey =
  | "history"
  | "copy-link"
  | "move"
  | "share-doc"
  | "publish"
  | "delete"
  | "request-deletion"
  | "withdraw-deletion";

export interface DocumentActionSpec {
  key: DocumentActionKey;
  label: string;
  testId: string;
  separatorBefore?: boolean;
  destructive?: boolean;
}

export interface DocumentActionsInput {
  /** Unsaved document (`nodeId === "new"`): nothing node-scoped applies. */
  isNew: boolean;
  /** Owner/admin tier — may grant and publish. */
  canShare: boolean;
  /** Archived nest: sharing and publishing are withheld (the server refuses). */
  isArchived: boolean;
  /** May author content here (editor-access.ts). Gates Move. */
  canEditContent: boolean;
  /** PDF node: Move is withheld, the server always rejects it. Default false. */
  isPdf?: boolean;
  /** Pending review by someone else: writes are locked server-side (423). */
  isLocked: boolean;
  /** May at least ask for deletion (editor tier and up). */
  canRequestDeletion: boolean;
  /** May delete outright (owner/admin tier, or the author). */
  canDeleteDirectly: boolean;
  /** A deletion request is currently pending on this document. */
  deletionRequested: boolean;
  /** …and the caller is the one who raised it. */
  isOwnDeletionRequest: boolean;
  /**
   * Offer "Version history" here. The markdown editor has no other entry
   * point; the artifact viewer carries its own History button. Default true.
   */
  includeVersionHistory?: boolean;
}

export function documentActions(input: DocumentActionsInput): DocumentActionSpec[] {
  const {
    isNew,
    canShare,
    isArchived,
    canEditContent,
    isPdf = false,
    isLocked,
    canRequestDeletion,
    canDeleteDirectly,
    deletionRequested,
    isOwnDeletionRequest,
    includeVersionHistory = true,
  } = input;
  const actions: DocumentActionSpec[] = [];

  if (!isNew && includeVersionHistory)
    actions.push({ key: "history", label: "Version history", testId: "document-editor-history" });

  if (!isNew)
    actions.push({
      key: "copy-link",
      label: "Copy link",
      testId: "document-editor-copy-link",
      separatorBefore: true,
    });

  if (!isNew && canEditContent && !isLocked && !isPdf)
    actions.push({ key: "move", label: "Move to folder", testId: "document-editor-move" });

  // Share THIS doc first — it's the narrower, more common ask. Meaningless on
  // an unsaved doc: there's no node id to grant on. Sharing the whole nest is
  // the top bar's Share button; only the per-document grant lives here.
  if (canShare && !isNew && !isArchived)
    actions.push({
      key: "share-doc",
      label: "Share this document",
      testId: "document-editor-share-doc",
      separatorBefore: true,
    });

  // Publishing hosts THIS document on the open web, so it sits with sharing
  // rather than with the editing actions above.
  if (canShare && !isNew && !isArchived)
    actions.push({ key: "publish", label: "Publish", testId: "document-editor-publish" });

  // One Delete entry: the author (and the admin/owner tier) deletes outright,
  // everyone else raises a request. Hidden below that tier once a flag is
  // already open.
  const showDelete =
    !isNew && canRequestDeletion && (canDeleteDirectly || !deletionRequested);
  if (showDelete)
    actions.push({
      key: canDeleteDirectly ? "delete" : "request-deletion",
      label: "Delete",
      testId: canDeleteDirectly
        ? "document-editor-delete"
        : "document-editor-request-deletion",
      separatorBefore: true,
      destructive: canDeleteDirectly,
    });

  // Withdraw: only the original requester, while the request is still
  // pending — undo an accidental flag without waiting for an admin to decline.
  // It belongs with Delete in the destructive group, so it only opens that
  // group when Delete isn't there to open it.
  if (!isNew && deletionRequested && isOwnDeletionRequest)
    actions.push({
      key: "withdraw-deletion",
      label: "Withdraw deletion request",
      testId: "document-editor-withdraw-deletion",
      separatorBefore: !showDelete,
    });

  return actions;
}
