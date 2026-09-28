import type { WorkItem } from "./api";

/**
 * Split the inbox: reviews (the only rows a batch decision applies to) and
 * requests (deletion / archive), which are decided one at a time and so list
 * after the reviews under their own header.
 */
export function splitWorkItems(items: WorkItem[]) {
  return {
    reviews: items.filter((w) => w.type === "review"),
    requests: items.filter((w) => w.type !== "review"),
  };
}
