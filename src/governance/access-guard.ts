/**
 * Access Guard — gates node reads with canUserAccess when the nest has
 * stewardship enabled. No-op otherwise, so existing ungoverned nests are
 * unaffected.
 */

import { getDb } from "../db/client.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { canUserAccess } from "./stewardship-service.js";
import { isPublicReader } from "../shared/access.js";
import { getApprovedVersion } from "./version-service.js";

/**
 * Resolve the caller's email from the auth context.
 * Falls back to "admin@localhost" in open mode (anonymous).
 */
export function resolveCallerEmail(userId: string | undefined): string {
  if (!userId) return "admin@localhost";
  const db = getDb();
  const row = db
    .prepare("SELECT email FROM users WHERE id = ?")
    .get(userId) as { email: string } | undefined;
  return row?.email || "admin@localhost";
}

/**
 * True when the caller can read this node.
 *
 * Resolution order:
 *   1. Public reader (visibility=public, no owner/collab grant) — only
 *      nodes that have an approved version. Drafts/pending stay private.
 *   2. Stewardship disabled — open read.
 *   3. Stewardship enabled — gate via canUserAccess.
 */
export function canReadNode(
  nestId: string,
  nodeId: string,
  userId: string,
  userEmail: string,
): boolean {
  if (isPublicReader(nestId, userId)) {
    return getApprovedVersion(nestId, nodeId) !== null;
  }
  if (!isStewardshipEnabled(nestId)) return true;
  return canUserAccess(nestId, nodeId, userEmail).allowed;
}

/**
 * Filter a list of node-like objects (with .id) down to those the caller
 * can read. Mirrors `canReadNode` resolution: public readers see approved
 * nodes only; collaborators bypass the gate when stewardship is off; with
 * stewardship on, each node is gated via canUserAccess.
 */
export function filterAccessible<T extends { id: string }>(
  nestId: string,
  userId: string,
  userEmail: string,
  nodes: T[],
): T[] {
  if (isPublicReader(nestId, userId)) {
    return nodes.filter((n) => getApprovedVersion(nestId, n.id) !== null);
  }
  if (!isStewardshipEnabled(nestId)) return nodes;
  return nodes.filter((n) => canUserAccess(nestId, n.id, userEmail).allowed);
}
