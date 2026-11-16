/**
 * Where Save should leave the user. Creating a document (`nodeId === "new"`)
 * has no page to stay on, so it lands back on the nest. Publishing a draft
 * opened from somewhere (the Board, the review queue) returns there, so the
 * next task is a click away. Any other save of an existing document leaves
 * the editor open on it — otherwise the app view moves to the nest Overview
 * while the address bar keeps `?doc=<id>` (CU-wdqcq02cxe), a UI/URL mismatch
 * that only a reload fixes.
 */
export function saveDestination(
  nodeId: string,
  opts: { publishedDraft?: boolean; hasReturnTo?: boolean } = {},
): "nest" | "return" | "stay" {
  if (nodeId === "new") return "nest";
  if (opts.publishedDraft && opts.hasReturnTo) return "return";
  return "stay";
}
