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
  nests: Array<{ id: string; name?: string; description?: string | null }>,
  query: string,
): NestMatch[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return nests
    .filter((n) => {
      const haystack = `${n.name ?? ""} ${n.description ?? ""} ${n.id ?? ""}`
        .toLowerCase();
      return terms.every((t) => haystack.includes(t));
    })
    .map((n) => ({
      id: n.id,
      title: n.name ?? n.id,
      description: n.description ?? null,
    }));
}
