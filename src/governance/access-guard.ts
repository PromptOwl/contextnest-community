/**
 * Access Guard — gates node reads with canUserAccess when the nest has
 * stewardship enabled. No-op otherwise, so existing ungoverned nests are
 * unaffected.
 */

import { getDb } from "../db/client.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { canUserAccess } from "./stewardship-service.js";

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
 * True when the caller can read this node. Cheap short-circuit when
 * stewardship_enabled is off on the nest.
 */
export function canReadNode(
  nestId: string,
  nodeId: string,
  userEmail: string,
): boolean {
  if (!isStewardshipEnabled(nestId)) return true;
  return canUserAccess(nestId, nodeId, userEmail).allowed;
}

/**
 * Filter a list of node-like objects (with .id) down to those the caller
 * can read. Returns the input unchanged when stewardship is disabled.
 */
export function filterAccessible<T extends { id: string }>(
  nestId: string,
  userEmail: string,
  nodes: T[],
): T[] {
  if (!isStewardshipEnabled(nestId)) return nodes;
  return nodes.filter((n) => canUserAccess(nestId, n.id, userEmail).allowed);
}
