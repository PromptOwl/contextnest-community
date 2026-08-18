/** One file uploaded by the browser's folder picker, path relative to the vault root. */
export interface ImportedFile {
  path: string;
  content: string;
}

/**
 * What counts as a non-content path segment in an imported vault: hidden dirs
 * (.git, .obsidian, .versions, .context) and node_modules never surface as
 * documents through flat discovery (FlatNestStorage).
 *
 * Discovery only — the files themselves still travel. The engine writes an
 * import in verbatim (`context_import` with `files[]`), so `.versions/` history
 * lands on disk and an imported version chain still reconstructs; it is simply
 * not a document.
 *
 * `_suggestions` (underscore, so not caught by the dot rule) is the engine's
 * per-doc staged-suggestion store. It is a nest's own derived governance state
 * — importing another vault's copy would surface its old suggestions as
 * phantom external edits (with stale, unresolvable doc ids), so we skip it.
 */
export function isSkippedSegment(segment: string): boolean {
  return (
    segment.startsWith(".") ||
    segment === "node_modules" ||
    segment === "_suggestions"
  );
}
