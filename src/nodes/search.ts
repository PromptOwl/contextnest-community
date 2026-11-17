import type { ContextNode, NestStorage } from "@promptowl/contextnest-engine";

/**
 * The document set both search routes match against: everything the nest's own
 * document list shows.
 *
 * `includeRetired` because discovery drops `status: rejected` by default — the
 * engine keeps those out of RETRIEVAL (CLI, MCP, prompt compilation), which is
 * right, but this app's node list deliberately keeps them (see
 * listNodesForCaller: a rejected doc is unpublished work its stewards still act
 * on). Without the flag a document sits in the nest, opens fine, and simply
 * cannot be found — the exact complaint global search exists to answer.
 *
 * It also reuses the cache entry `listNodesForCaller` already warms, instead of
 * populating a second one, so this costs one crawl fewer rather than one more.
 */
export async function discoverForSearch(
  storage: Pick<NestStorage, "discoverDocuments">,
): Promise<ContextNode[]> {
  // Rejected stays findable; archived is out of the list, so out of search too.
  return (await storage.discoverDocuments({ includeRetired: true })).filter((d) => !d.frontmatter.archived);
}

/** Lowercase with accents stripped, so "cafe" finds "Café". For comparing
 *  only — hits keep their original text. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * How well a hit's TITLE answers the query — the only ranking signal, because
 * the title is what someone typing a document's name is aiming at.
 *
 * Results are capped (per-request `limit`, and again by the palette), and until
 * this existed the cap fell in nest-creation order: a body mention of the word
 * in an older nest could push the document actually named in the query off the
 * end of the list. Body-only matches all score 0 and keep discovery order.
 *
 * Takes a bare title so it can rank engine documents and already-serialized
 * search hits with the same rule.
 */
export function titleScore(title: string, query: string): number {
  const t = fold(title || "");
  const q = fold(query.trim());
  if (!q) return 0;
  if (t === q) return 4;

  // Where the query lands in the title matters as much as whether it lands.
  // Matching is plain substring, so "Latest" contains "test" — without the tier
  // below, "Law IV — Consumers Track the Latest Engine" scored exactly as high
  // as the document called "Test 1". Scan every occurrence, not just the first:
  // the good hit can come second.
  //
  // The test is that the query STARTS a word, not that it is a whole one — only
  // the character before is checked. Deliberate, for a palette you type into:
  // "test" should rank "testing level 1" highly while it is still being typed.
  // So "test123abc" scores here too; that is the same leniency, not a miss.
  let midWord = false;
  for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + 1)) {
    if (i === 0) return 3;
    if (!/[a-z0-9]/.test(t[i - 1]!)) return 2;
    midWord = true;
  }
  if (midWord) return 1;

  // Multi-word queries whose terms are all in the title but not adjacent —
  // "email doc" for "Test Email connection Doc".
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length > 1 && terms.every((term) => t.includes(term))) return 1;
  return 0;
}

/** Free-text match over title, body, type and tags. Every whitespace-separated
 *  term must appear somewhere (AND), case- and accent-insensitive substring — the same rule
 *  the per-nest and cross-nest search routes both run on. Title matches sort
 *  first (see titleScore); ties keep discovery order, since Array#sort is
 *  stable. Cross-nest search re-sorts the merged list by the same score, so
 *  this sort is redundant on that path — kept because it is what makes a
 *  per-nest result ordered at all, and it runs over matches, not the nest. */
export function matchDocuments<T extends ContextNode>(
  documents: T[],
  query: string,
): T[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return documents
    .filter((node) => {
      const haystack = fold(
        [
          node.frontmatter.title,
          node.body || "",
          node.frontmatter.type || "",
          ...(node.frontmatter.tags || []),
        ].join(" "),
      );
      return terms.every((term) => haystack.includes(term));
    })
    .sort(
      (a, b) =>
        titleScore(b.frontmatter.title, query) -
        titleScore(a.frontmatter.title, query),
    );
}

/** A ~200 char window of the body around the first matching term, so the
 *  caller can see *why* a body-text hit came back. Falls back to the head of
 *  the body when no term is in the body (title/tag-only match). */
function bodySnippet(body: string, query?: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const terms = fold(query || "").split(/\s+/).filter(Boolean);
  const folded = fold(flat);
  const at = terms
    .map((t) => folded.indexOf(t))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (at === undefined || at < 80) return flat.slice(0, 200);
  const start = Math.max(0, at - 60);
  return `…${flat.slice(start, start + 200)}`;
}

/** The wire shape both search routes return per hit. */
export function toSearchHit(node: ContextNode, query?: string) {
  return {
    id: node.id,
    title: node.frontmatter.title,
    type: node.frontmatter.type || "document",
    tags: node.frontmatter.tags || [],
    snippet: bodySnippet(node.body || "", query),
  };
}
