import type { WorkItem } from "./api";

/**
 * Split the inbox: reviews (the only rows a batch decision applies to) and
 * requests (deletion / archive / access), which are decided one at a time and so list
 * after the reviews under their own header.
 */
export function splitWorkItems(items: WorkItem[]) {
  return {
    reviews: items.filter((w) => w.type === "review"),
    requests: items.filter((w) => w.type !== "review"),
  };
}

/**
 * A row's identity in the inbox. Reviews and deletion flags are one per
 * document, so the document names them; an access request isn't — two people
 * can ask about the same document, and a review can sit on it too — so it is
 * named by its own request id.
 */
export function workItemKey(w: WorkItem): string {
  return w.type === "access" && w.request_id
    ? `access:${w.request_id}`
    : `${w.nest_id}:${w.node_id}`;
}
