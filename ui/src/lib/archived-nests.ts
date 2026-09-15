/**
 * Client-side name filter + sort for the Dashboard's Archived tab — mirrors
 * the live Nests tab's own filter/sort pattern, scoped to the archived list
 * so the two tabs don't share state that means something different in each.
 */
export interface ArchivedNest {
  name?: string;
  archived_at?: string | null;
}

export type ArchivedNestSort = "archived" | "name";

export function filterAndSortArchivedNests<T extends ArchivedNest>(
  nests: T[],
  query: string,
  sort: ArchivedNestSort,
): T[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? nests.filter((n) => (n.name ?? "").toLowerCase().includes(q))
    : nests;
  return [...matched].sort((a, b) =>
    sort === "name"
      ? String(a.name ?? "").localeCompare(String(b.name ?? ""))
      : String(b.archived_at ?? "").localeCompare(String(a.archived_at ?? "")),
  );
}
