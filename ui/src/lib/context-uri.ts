/**
 * `contextnest://` links in a document body (engine §4). A viewer treats a
 * document URI exactly like a `[[wikilink]]` to that path; tag, search and
 * folder URIs have no page to open, so they stay plain text.
 */
export const CONTEXT_URI_PREFIX = "contextnest://";

/**
 * Bare URIs in prose — up to whitespace or a bracket/quote that ends the
 * token. Sentence punctuation right after the URI (`…/deals.`, `…/deals:`)
 * belongs to the prose, so the match stops before it and the viewer keeps
 * it as text.
 */
export const CONTEXT_URI_RE = /contextnest:\/\/[^\s<>()[\]"'`,;]*[^\s<>()[\]"'`,;.:!?]/g;

/**
 * The node path a document URI points at (`nodes/gtm/deals`), with any
 * `@checkpoint` pin and `#anchor` dropped; null when the URI is not a
 * document (tag/, search/, a trailing-slash folder) or is malformed.
 */
export function contextUriDocPath(uri: string): string | null {
  if (!uri.startsWith(CONTEXT_URI_PREFIX)) return null;
  let rest = uri.slice(CONTEXT_URI_PREFIX.length);
  if (!rest || rest.includes("//")) return null;
  if (rest.startsWith("tag/") || rest.startsWith("search/")) return null;
  // Pin and anchor first — a fragment may end in "/" without making the
  // URI a folder. Then any sentence punctuation a caller left on.
  rest = rest.split("#")[0].split("@")[0].replace(/[.,;:!?]+$/, "");
  if (!rest || rest.endsWith("/")) return null;
  return rest;
}

/** What a bare URI reads as on screen: the page's slug. */
export function contextUriLabel(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
