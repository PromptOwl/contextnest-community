import { fold } from "./node-filter";

/** Client-side nest matching for the search palette.
 *
 * The server searches documents; nests are already in the cached list, so
 * filtering them here beats a second round-trip. Same AND-of-terms,
 * case-insensitive rule the document search uses, over the fields a nest has.
 */
export interface NestMatch {
  id: string;
  title: string;
  description: string | null;
}

export function matchNests(
  nests: Array<{
    id: string;
    name?: string;
    description?: string | null;
    pinned?: boolean;
  }>,
  query: string,
): NestMatch[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return nests
    .filter((n) => {
      const haystack = fold(`${n.name ?? ""} ${n.description ?? ""} ${n.id ?? ""}`);
      return terms.every((t) => haystack.includes(t));
    })
    // Pinned nests lead among matches, so the palette and the dashboard agree
    // about which nests matter to this person. It only breaks ties in relevance
    // — a pin never promotes a nest that didn't match the query at all.
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
    .map((n) => ({
      id: n.id,
      title: n.name ?? n.id,
      description: n.description ?? null,
    }));
}
