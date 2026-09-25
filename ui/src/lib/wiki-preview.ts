/**
 * Hover-preview helpers for wiki links — pure, framework-free, unit-testable
 * in the node test env. Resolution mirrors WikiLink.checkExists and
 * lib/backlinks: a `[[target]]` matches a node by id, title, or bare slug,
 * case-insensitive.
 */

export interface PreviewNode {
  id: string;
  title: string;
  content?: string;
}

function bareSlug(s: string): string {
  const idx = s.lastIndexOf("/");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/** The node a wiki-link target resolves to, or null. */
export function resolveWikiTarget(
  nodes: PreviewNode[],
  target: string,
): PreviewNode | null {
  const lower = target.trim().toLowerCase();
  if (!lower) return null;
  const slug = bareSlug(lower);
  return (
    nodes.find(
      (n) =>
        n.id.toLowerCase() === lower ||
        n.title.toLowerCase() === lower ||
        bareSlug(n.id).toLowerCase() === slug,
    ) ?? null
  );
}

export type WikiLinkAction =
  | { kind: "navigate"; node: PreviewNode }
  | { kind: "create"; title: string }
  | { kind: "blocked"; title: string };

/**
 * Decide what a `[[Title]]` click should do. Deliberately takes no `id` —
 * only ever consults the live node list — so a link never navigates on a
 * stale, cached id (the WikiLink decoration's existence check can go stale
 * between when it ran and when the link is clicked, e.g. the target was
 * renamed or deleted). A target that doesn't resolve always falls through to
 * "create" (or "blocked" for a non-authoring role) rather than a dead end
 * (CU-wdqcq02g17).
 *
 * `target` is the link's internal id (aliased links store `[[nodes/<id>|Title]]`
 * — see `formatWikiLink`), so once the node it points at is gone it's no
 * longer a human-readable title. `displayText` is the alias shown to the
 * reader; when present it's what "create"/"blocked" report as the title so a
 * broken aliased link doesn't leak `nodes/<id>` into the New Document form.
 */
export function decideWikiLinkAction(
  nodes: PreviewNode[],
  target: string,
  canAuthor: boolean,
  displayText?: string | null,
): WikiLinkAction {
  const node = resolveWikiTarget(nodes, target);
  if (node) return { kind: "navigate", node };
  const title = displayText?.trim() || target;
  return canAuthor ? { kind: "create", title } : { kind: "blocked", title };
}

/**
 * Whether a `[[Title]]` should render with broken-link styling in a
 * read-only view, given the same target resolution the hover preview
 * uses (`previewFor`, wired to `resolveWikiTarget` by the caller).
 * No `previewFor` means there's nothing to resolve against — stay
 * optimistic, matching the editor's own `checkExists`-less default
 * (see WikiLink.ts's `exists = cached?.exists ?? !checkExists`).
 */
export function wikiLinkIsBroken(
  target: string,
  previewFor?: (target: string) => { title: string; snippet: string } | null,
): boolean {
  if (!previewFor) return false;
  return previewFor(target) === null;
}

/** A short plain-text snippet of a markdown body for the preview card. */
export function previewSnippet(content: string, maxLen = 280): string {
  const plain = (content ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, a) => a ?? t)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxLen ? plain.slice(0, maxLen).trimEnd() + "…" : plain;
}
