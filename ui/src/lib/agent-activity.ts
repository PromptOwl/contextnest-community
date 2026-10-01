/**
 * Agent activity (CU-wdqcq0314v) — the words the panel shows. Kept apart from
 * the component so the promise an Undo makes is tested as plain text.
 */
import type { AgentActivityItem, AgentActivityKind } from "./api";

const KIND_LABEL: Record<AgentActivityKind, string> = {
  create: "Created",
  update: "Edited",
  restore: "Restored",
  delete: "Deleted",
};

export const kindLabel = (kind: AgentActivityKind): string => KIND_LABEL[kind];

/** What the confirm dialog promises, per effect. Empty when there is no undo. */
export function undoPromise(item: AgentActivityItem): string {
  if (!item.undo.available) return "";
  const doc = item.title ? `“${item.title}”` : item.nodeId;
  switch (item.undo.effect) {
    case "restore":
      return `${doc} goes back to version ${item.undo.restoreTo}, saved as a new version. The agent's version stays in the history.`;
    case "discard":
      return `The unreviewed draft of ${doc} is thrown away and the published version comes back. If it was never published, the document is removed.`;
    case "delete":
      return `${doc} was created by this change, so undoing it deletes the document.`;
    default:
      return "";
  }
}
