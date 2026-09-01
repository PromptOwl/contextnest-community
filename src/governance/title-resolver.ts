/**
 * Title resolver — shared helper for surfacing on-disk document titles
 * to governance APIs. The governance DB stores node ids ("nodes/foo"); the
 * user-facing title lives in the frontmatter on disk. Endpoints that list
 * by node id (review queue, stewards) call this to enrich responses so
 * the UI never has to render the raw storage path.
 */

import { engineCache } from "../nodes/engine.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";

export async function buildTitleMap(
  nestId: string,
): Promise<Map<string, string>> {
  try {
    const { storage } = await engineCache.get(nestId);
    const docs = await storage.discoverDocuments();
    return new Map(docs.map((d) => [d.id, d.frontmatter.title as string]));
  } catch {
    return new Map();
  }
}

/**
 * The folder a node lives in, derived from its id. Node ids are
 * "nodes/<folder segments…>/<slug>" (see nodes/service.ts). Returns the
 * folder path ("Marketing/API"), or "" for a root-level document.
 *
 * An imported vault's ids carry a prefix before that — "<nestId>/nodes/…" —
 * so everything up to and INCLUDING the first "nodes" SEGMENT is dropped, not
 * just a leading one. Without this the folder rendered as a raw uuid path.
 *
 * Segment-aware on purpose: a substring match would also fire inside a segment
 * that merely contains "nodes/", and this is shared with the notification and
 * email labels, so a wrong answer here travels further than one list.
 */
export function folderForNode(nodeId: string): string {
  const segments = nodeId.split("/");
  const root = segments.indexOf("nodes");
  return segments.slice(root + 1, -1).join("/");
}

/**
 * Human-facing label for a node in a notification: its document title (from
 * frontmatter) plus the folder it lives under, so a reviewer sees "API limits
 * (in Marketing/API)" rather than the raw "nodes/marketing/api/xyz" path.
 * Falls back to the node id if the title can't be resolved.
 */
export async function describeNode(
  nestId: string,
  nodeId: string,
): Promise<string> {
  const title = await titleForNode(nestId, nodeId);
  const folder = folderForNode(nodeId);
  return folder ? `${title} (in ${folder})` : title;
}

/** The document's title alone — for anywhere the folder suffix would read
 *  oddly (email subjects, verdict messages). Never returns a storage path. */
export async function titleForNode(
  nestId: string,
  nodeId: string,
): Promise<string> {
  const titles = await buildTitleMap(nestId);
  return titles.get(nodeId) || titleFallback(titles, nodeId);
}

/**
 * Best-effort title for an id the map doesn't hold verbatim. Callers have been
 * seen passing ids carrying a leading nest prefix ("<nestId>/nodes/foo/bar"),
 * which misses the map and used to leak the whole storage path into a
 * notification. Retry from the "nodes/" segment, then fall back to the slug —
 * never the raw path.
 */
function titleFallback(titles: Map<string, string>, nodeId: string): string {
  const at = nodeId.indexOf("nodes/");
  if (at > 0) {
    const normalized = nodeId.slice(at);
    const hit = titles.get(normalized);
    if (hit) return hit;
  }
  return nodeId.split("/").pop() || nodeId;
}

/**
 * "gtm-deals/api" → "Gtm Deals / Api" — a folder path in human form.
 * Folder names are slugs on disk, so a queue row or email that prints the raw
 * path reads like storage. Mirrors the UI's prettyFolderPath (FolderTree.tsx);
 * keep the two in step.
 */
export function prettyFolderPath(path: string): string {
  return path
    .replace(/^nodes\//, "")
    .split("/")
    .filter(Boolean)
    .map((seg) =>
      seg
        .split(/[-_]/)
        .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
        .join(" "),
    )
    .join(" / ");
}

/** The nest's human name (best-effort; falls back to the id). */
export async function nestName(nestId: string): Promise<string> {
  try {
    const row = (await getDb().get("SELECT name FROM nests WHERE id = ?", [
      nestId,
    ])) as { name?: string } | undefined;
    return row?.name || nestId;
  } catch {
    return nestId;
  }
}

/**
 * Direct link to open a document in the UI: matches the app's own deep-link
 * shape (`?nest=<id>&doc=<nodeId>`). `baseUrl` is the request-derived origin
 * (or PUBLIC_BASE_URL when set); empty when neither is available — the email
 * template then omits the "Open document" button.
 */
export function docLink(
  nestId: string,
  nodeId?: string,
  baseUrl?: string,
): string {
  const base = baseUrl || config.PUBLIC_BASE_URL;
  if (!base) return "";
  const q = new URLSearchParams({ nest: nestId });
  if (nodeId) q.set("doc", nodeId);
  return `${base.replace(/\/$/, "")}/?${q.toString()}`;
}

/**
 * Canonical node → URL resolver: the one place a node's user-facing URL is
 * built, so the future public `/p/:slug` site URL swaps in here instead of at
 * every call site. `undefined` when nothing resolves, so callers omit the
 * field rather than emit a broken href.
 */
export function resolveNodeUrl(
  node: { id: string },
  opts: { nestId: string; baseUrl?: string },
): string | undefined {
  return docLink(opts.nestId, node.id, opts.baseUrl) || undefined;
}

/**
 * Resolve the structured pieces the email connector needs for a document
 * event: the document title, its "Nest / Subfolder" path, and a direct link.
 * `baseUrl` is the request-derived origin used to build the link.
 */
export async function buildDocContext(
  nestId: string,
  nodeId: string,
  baseUrl?: string,
): Promise<{ docTitle: string; label: string; path: string; link: string }> {
  const titles = await buildTitleMap(nestId);
  const docTitle = titles.get(nodeId) || nodeId;
  const folder = folderForNode(nodeId);
  const name = await nestName(nestId);
  return {
    docTitle,
    // Slack one-liner label ("Title (in Folder)"), same as describeNode().
    label: folder ? `${docTitle} (in ${folder})` : docTitle,
    path: folder ? `${name} / ${folder}` : name,
    link: docLink(nestId, nodeId, baseUrl),
  };
}
