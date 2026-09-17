/**
 * `contextnest://` links in a document body (engine §4). A viewer treats a
 * document URI exactly like a `[[wikilink]]` to that path; tag, search and
 * folder URIs have no page to open, so they stay plain text.
 */
export const CONTEXT_URI_PREFIX = "contextnest://";

/** Bare URIs in prose — up to whitespace or a bracket/quote that ends the token. */
export const CONTEXT_URI_RE = /contextnest:\/\/[^\s<>()[\]"'`,;]+/g;

/**
 * The node path a document URI points at (`nodes/gtm/deals`), with any
 * `@checkpoint` pin and `#anchor` dropped; null when the URI is not a
 * document (tag/, search/, a trailing-slash folder) or is malformed.
 */
export function contextUriDocPath(uri: string): string | null {
  if (!uri.startsWith(CONTEXT_URI_PREFIX)) return null;
  let rest = uri.slice(CONTEXT_URI_PREFIX.length).replace(/[.,;:!?]+$/, "");
  if (!rest || rest.includes("//")) return null;
  if (rest.startsWith("tag/") || rest.startsWith("search/") || rest.endsWith("/")) return null;
  rest = rest.split("#")[0].split("@")[0];
  return rest || null;
}

/** What a bare URI reads as on screen: the page's slug. */
export function contextUriLabel(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
