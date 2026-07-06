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
 */
export function folderForNode(nodeId: string): string {
  return nodeId
    .replace(/^nodes\//, "")
    .split("/")
    .slice(0, -1)
    .join("/");
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
  const titles = await buildTitleMap(nestId);
  const title = titles.get(nodeId) || nodeId;
  const folder = folderForNode(nodeId);
  return folder ? `${title} (in ${folder})` : title;
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
