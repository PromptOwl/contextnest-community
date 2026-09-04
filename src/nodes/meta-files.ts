/**
 * Files a vault carries that are not documents.
 *
 * The engine regenerates these on every mutation (per-folder INDEX.md, the
 * vault's CONTEXT.md preamble, the agent configs), so surfacing one as an
 * editable node only invites an edit the next write throws away.
 *
 * The engine's own exclusion is root-only for CONTEXT.md and misses QWEN.md;
 * FlatNestStorage's missed README.md. One list, applied to every read.
 */
const META_BASENAMES = new Set([
  "INDEX",
  "CONTEXT",
  "CLAUDE",
  "GEMINI",
  "AGENTS",
  "QWEN",
  "README",
]);

/** True for a derived file, given a document id ("gtm/INDEX") or a
 *  vault-relative path ("gtm/INDEX.md"). */
export function isMetaFile(idOrPath: string): boolean {
  const base = idOrPath.split(/[/\\]/).pop() ?? "";
  return META_BASENAMES.has(base.replace(/\.md$/i, ""));
}
