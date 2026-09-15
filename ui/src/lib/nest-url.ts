/**
 * A nest's own URL is `/nest/<id>` (CU-wdqcq024b4). The older `?nest=<id>`
 * query form is still read so existing links and server-built emails keep
 * resolving; the app only ever writes the path form.
 */
const NEST_PATH = /^\/nest\/([^/]+)\/?$/;

export function nestIdFromLocation(
  loc: { pathname: string; search: string } = window.location,
): string | null {
  const m = loc.pathname.match(NEST_PATH);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(loc.search).get("nest");
}

export function nestPath(nestId: string | null | undefined): string {
  return nestId ? `/nest/${encodeURIComponent(nestId)}` : "/";
}
