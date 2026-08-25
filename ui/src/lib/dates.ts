/**
 * Server timestamps come in two shapes, and one of them lies.
 *
 * Rows written from JS carry ISO-8601 with a zone ("2026-08-04T05:02:32.000Z").
 * Rows written by a SQL default (`datetime('now')`, Postgres `NOW()`) carry
 * "2026-08-04 05:02:32" — UTC, but with nothing saying so. `new Date()` reads
 * that second shape as LOCAL time, so a request raised a minute ago renders as
 * "5h ago" for a reader at UTC+5:30.
 *
 * Parse every server timestamp through here.
 */
export function parseServerDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  // "YYYY-MM-DD HH:MM:SS[.fff]" — no zone, no "T". Stamp it as the UTC it is.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Local-time absolute rendering ("04/08/2026, 10:32:32"). */
export function formatServerDate(raw: string | null | undefined): string {
  return parseServerDate(raw)?.toLocaleString() ?? "";
}

/** "just now" / "5m ago" / "3h ago" / "7d ago". */
export function relTime(raw: string | null | undefined): string {
  const then = parseServerDate(raw)?.getTime();
  if (then == null) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
