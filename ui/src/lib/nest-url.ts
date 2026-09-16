/**
 * A nest's own URL is `/nest/<id>` (CU-wdqcq024b4); its views sit one
 * segment deeper, `/nest/<id>/board`, `/nest/<id>/graph`… (the segment is a
 * nest page's `meta.path`, see nest-pages.ts). The older `?nest=<id>` and
 * `?view=<segment>` query forms are still read so existing links and
 * server-built emails keep resolving; the app only ever writes the path form.
 */
const NEST_PATH = /^\/nest\/([^/]+)(?:\/([a-z0-9-]+))?\/?$/;

function decodeSegment(raw: string): string {
  // A malformed escape (a truncated paste ending in "%") throws here; keep
  // the raw segment so the probe 404s instead of the app crashing.
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function nestIdFromLocation(
  loc: { pathname: string; search: string } = window.location,
): string | null {
  const m = loc.pathname.match(NEST_PATH);
  if (m) return decodeSegment(m[1]);
  return new URLSearchParams(loc.search).get("nest");
}

/** The view segment after the nest id, or the legacy ?view= value. */
export function nestViewFromLocation(
  loc: { pathname: string; search: string } = window.location,
): string | null {
  const m = loc.pathname.match(NEST_PATH);
  if (m?.[2]) return m[2];
  return new URLSearchParams(loc.search).get("view");
}

export function nestPath(nestId: string | null | undefined, view?: string | null): string {
  if (!nestId) return "/";
  const base = `/nest/${encodeURIComponent(nestId)}`;
  return view ? `${base}/${view}` : base;
}
