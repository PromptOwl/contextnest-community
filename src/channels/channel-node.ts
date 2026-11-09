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

/** Is this node a channel? Cheap for every other id (regex first). */
export async function isChannelNode(nestId: string, nodeId: string): Promise<boolean> {
  if (!isChannelId(nodeId)) return false;
  const node = await readChannelDoc(nestId, nodeId);
  return !!node && isChannelDoc(node);
}
