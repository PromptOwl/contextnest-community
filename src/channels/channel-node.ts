/**
 * What makes a node a channel — the leaf both the channel service and the
 * access guard read, so neither has to import the other.
 *
 * A channel is a direct child of `nodes/channels/` carrying the `#channel`
 * tag (channel-service.ts has the why). The regex comes first everywhere: for
 * every other node id the answer costs nothing.
 */
import type { ContextNode } from "@promptowl/contextnest-engine";
import { engineCache } from "../nodes/engine.js";
import { normalizeTag } from "../governance/tag-index-service.js";
import { getDb } from "../db/client.js";

export const CHANNEL_FOLDER = "channels";
export const CHANNEL_TAG = "channel";
export const ARCHIVED_TAG = "archived";

export const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CHANNEL_ID_RE = /^nodes\/channels\/([a-z0-9][a-z0-9-]{0,62})$/;

/** Cheap pre-filter: could this node id be a channel at all? */
export function isChannelId(nodeId: string): boolean {
  return CHANNEL_ID_RE.test(nodeId);
}

/** "nodes/channels/ops" → "ops"; null for any other id. */
export function channelNameOf(nodeId: string): string | null {
  return CHANNEL_ID_RE.exec(nodeId)?.[1] ?? null;
}

export function tagsOf(node: { frontmatter?: { tags?: unknown } | null }): string[] {
  const raw = node.frontmatter?.tags;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
}

export function hasTag(node: { frontmatter?: { tags?: unknown } | null }, tag: string): boolean {
  return tagsOf(node).some((t) => normalizeTag(t) === tag);
}

/** A channel = a direct child of `nodes/channels/` carrying the #channel tag. */
export function isChannelDoc(node: { id: string; frontmatter?: { tags?: unknown } | null }): boolean {
  return isChannelId(node.id) && hasTag(node, CHANNEL_TAG);
}

export async function readChannelDoc(nestId: string, nodeId: string): Promise<ContextNode | null> {
  try {
    const { storage } = await engineCache.get(nestId);
    return await storage.readDocument(nodeId);
  } catch {
    return null;
  }
}

/**
 * Is this node a channel? Cheap for every other id (regex first).
 *
 * Fails CLOSED. A document that can't be read or parsed (a bad push, a hand
 * edit, a storage hiccup) must not stop being a channel for the access rules
 * that depend on this answer: it is still one if the tag index says so, or if
 * the node under nodes/channels/ already holds conversation threads.
 */
export async function isChannelNode(nestId: string, nodeId: string): Promise<boolean> {
  if (!isChannelId(nodeId)) return false;
  const node = await readChannelDoc(nestId, nodeId);
  if (node) return isChannelDoc(node);
  const row = await getDb()
    .get(
      `SELECT 1 AS hit WHERE EXISTS (SELECT 1 FROM node_tag_index WHERE nest_id = ? AND node_id = ? AND tag_name = ?)
          OR EXISTS (SELECT 1 FROM annotation_threads WHERE nest_id = ? AND node_id = ?)`,
      [nestId, nodeId, CHANNEL_TAG, nestId, nodeId],
    )
    .catch(() => ({ hit: 1 }));
  return !!row;
}
