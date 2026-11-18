/**
 * Links a PERSON opens in a browser: the web app's own addresses.
 *
 *   /nest/<nest id>                  the nest
 *   /nest/<nest id>?doc=<node id>    one document in it
 *
 * The same shape the UI writes (ui/src/lib/nest-url.ts — test/web-links.test.ts
 * holds the two together). Not to be confused with the API under /nests/<id>
 * (plural), which answers agents and programs with JSON: handing a person that
 * address is how they end up on a 404.
 *
 * A link is only an address. Opening it goes through the server's access
 * rules, so it gives nothing to someone who cannot read the nest or document.
 */

/** Path of a nest's page in the web app. */
export function nestWebPath(nestId: string): string {
  return `/nest/${encodeURIComponent(nestId)}`;
}

/** Path of one document's page in the web app. */
export function documentWebPath(nestId: string, nodeId: string): string {
  return `${nestWebPath(nestId)}?doc=${encodeURIComponent(nodeId)}`;
}

const origin = (baseUrl: string | undefined | null) => (baseUrl || "").replace(/\/+$/, "");

/** Absolute link to a nest. "" when the server's public address is unknown —
 *  a relative link is no use to someone reading it in a chat window. */
export function nestWebUrl(baseUrl: string | undefined | null, nestId: string): string {
  const base = origin(baseUrl);
  return base ? `${base}${nestWebPath(nestId)}` : "";
}

/** Absolute link to a document. "" when the server's public address is unknown. */
export function documentWebUrl(
  baseUrl: string | undefined | null,
  nestId: string,
  nodeId: string,
): string {
  const base = origin(baseUrl);
  return base ? `${base}${documentWebPath(nestId, nodeId)}` : "";
}
