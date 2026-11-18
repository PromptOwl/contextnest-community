/**
 * A stored timestamp as an instant (ms since the epoch), or NaN when it can't
 * be read. Rows hold both SQLite's `datetime('now')` ("YYYY-MM-DD HH:MM:SS",
 * UTC, no zone) and ISO-8601 strings, which don't compare as text.
 */
export function dbTimeMs(at: string | null | undefined): number {
  if (!at) return NaN;
  return Date.parse(/[TZ]/.test(at) ? at : `${at.replace(" ", "T")}Z`);
}
