/** The four queues of the My Work review workspace. Pure. */
import type { MyDraft, WorkItem } from "./api";

export type ReviewQueueKey = "review" | "sent_back" | "drafts" | "mine";

/** A draft that came back from a reviewer lives in Sent back; the rest in Drafts. */
export function splitDrafts(drafts: readonly MyDraft[]) {
  return {
    sentBack: drafts.filter((d) => d.status === "rejected"),
    drafts: drafts.filter((d) => d.status !== "rejected"),
  };
}

/** Only the reviews whose version is still the newest. A server that doesn't
 *  say counts as up to date: the bulk call refuses a stale one anyway. */
export function upToDateReviews(items: readonly WorkItem[]): WorkItem[] {
  return items.filter((w) => w.type === "review" && w.up_to_date !== false);
}

/** "nodes/ontology/core/x" → ["ontology", "core"]. */
export function crumbFolders(nodeId: string): string[] {
  const parts = nodeId.split("/");
  if (parts[0] === "nodes") parts.shift();
  return parts.slice(0, -1);
}
