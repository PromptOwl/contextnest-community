/**
 * Where Save should leave the user. Creating a document (`nodeId === "new"`)
 * has no page to stay on, so it lands back on the nest; saving an existing
 * document should leave the editor open on that same document — otherwise
 * the app view moves to the nest Overview while the address bar keeps
 * `?doc=<id>` (CU-wdqcq02cxe), a UI/URL mismatch that only a reload fixes.
 */
export function shouldReturnToNestOnSave(nodeId: string): boolean {
  return nodeId === "new";
}
