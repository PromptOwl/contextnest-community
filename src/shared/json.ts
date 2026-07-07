/**
 * Parse a JSON column value, tolerating null/blank and malformed content by
 * returning null rather than throwing. Shared by every surface that stores
 * freeform JSON in a TEXT column (runs, edges, edge types) so the three
 * copies that used to live inline can't drift.
 */
export const safeJson = (s: string | null | undefined): unknown => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
