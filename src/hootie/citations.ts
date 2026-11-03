/**
 * How a `[[X]]` in Hootie's answer resolves to a document (pure).
 *
 * The model is asked to cite by exact title, but in practice it also copies
 * the slug links nest bodies carry (`[[project-november-live-dashboard]]`),
 * writes a full id, or retypes a title with a different dash or quote. Each
 * of those names a retrieved document just as clearly, so a citation matches
 * a node by its title, its full id, or its id's last segment (the slug), all
 * compared through `citationKey` (case, dash and quote variants, whitespace).
 *
 * Only the nodes passed in are ever candidates — the route passes what it
 * retrieved for this caller, so a link to anything the caller can't read
 * (or that wasn't retrieved) never resolves.
 *
 * The panel (ui/src/lib/hootie-panel.ts) imports this module, so keep it
 * pure and import-free: the UI bundle pulls it in as-is.
 */

export interface CitableNode {
  id: string;
  title: string;
}

/** `[[…]]` with no brackets or line break inside. */
export const WIKI_LINK = /\[\[([^[\]\n]+)\]\]/g;

/** The comparison form of a title, id or slug. */
export function citationKey(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‐-―−﹘﹣－]/g, "-")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** `target|alias` → what to resolve, and what to show (null: the title). */
export function splitWikiLink(inner: string): { target: string; label: string | null } {
  const bar = inner.indexOf("|");
  if (bar < 0) return { target: inner.trim(), label: null };
  const label = inner.slice(bar + 1).trim();
  return { target: inner.slice(0, bar).trim(), label: label || null };
}

/**
 * A resolver over `nodes`. Titles win over ids and ids over slugs, and within
 * each, the first node in `nodes` order wins (the open document, then the
 * better-ranked match) — so a shared title or slug resolves to ONE node.
 */
export function citationResolver<T extends CitableNode>(nodes: readonly T[]): (target: string) => T | undefined {
  const byKey = new Map<string, T>();
  const add = (key: string, n: T) => {
    if (key && !byKey.has(key)) byKey.set(key, n);
  };
  for (const n of nodes) add(citationKey(n.title), n);
  for (const n of nodes) add(citationKey(n.id), n);
  for (const n of nodes) add(citationKey(n.id.slice(n.id.lastIndexOf("/") + 1)), n);
  return (target) => byKey.get(citationKey(target));
}

export function resolveCitation<T extends CitableNode>(target: string, nodes: readonly T[]): T | undefined {
  return citationResolver(nodes)(target);
}

/** The nodes `answer` cites, in order of first mention, each once. */
export function citedNodes<T extends CitableNode>(answer: string, nodes: readonly T[]): T[] {
  const resolve = citationResolver(nodes);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const m of answer.matchAll(WIKI_LINK)) {
    const n = resolve(splitWikiLink(m[1]).target);
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}
