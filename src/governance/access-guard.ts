/**
 * Access Guard — gates node reads with canUserAccess when the nest has
 * stewardship enabled. No-op otherwise, so existing ungoverned nests are
 * unaffected.
 */

import { getDb } from "../db/client.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { canUserAccess } from "./stewardship-service.js";
import { isPublicReader, resolveNestPermission } from "../shared/access.js";
import { getApprovedVersion, getApprovedVersions } from "./version-service.js";
import {
  resolveNodeGrant,
  listUserGrants,
  grantCoversNode,
} from "./grants-service.js";

/**
 * Resolve the caller's email from the auth context.
 * Falls back to "admin@localhost" in open mode (anonymous).
 */
export async function resolveCallerEmail(userId: string | undefined): Promise<string> {
  if (!userId) return "admin@localhost";
  const db = getDb();
  const row = await db.get(
    "SELECT email FROM users WHERE id = ?",
    [userId],
  ) as { email: string } | undefined;
  return row?.email || "admin@localhost";
}

/**
 * True when the caller can read this node.
 *
 * Resolution order:
 *   1. Public reader (visibility=public, no owner/collab grant) — only
 *      nodes that have an approved version. Drafts/pending stay private.
 *   2. Stewardship disabled — open read.
 *   3. Stewardship enabled — gate via canUserAccess, OR a share grant covering
 *      this node. A doc/folder grant confers read regardless of governance
 *      mode; without this the grants-blind steward check 403s a valid grantee
 *      on a governed nest (the middleware already let them in).
 */
export async function canReadNode(
  nestId: string,
  nodeId: string,
  userId: string,
  userEmail: string,
): Promise<boolean> {
  if (await isPublicReader(nestId, userId)) {
    return (await getApprovedVersion(nestId, nodeId)) !== null;
  }
  if (!(await isStewardshipEnabled(nestId))) return true;
  if ((await canUserAccess(nestId, nodeId, userEmail)).allowed) return true;
  return (await resolveNodeGrant(nestId, userId, nodeId)) !== null;
}

/**
 * Filter a list of node-like objects (with .id) down to those the caller
 * can read. Mirrors `canReadNode` resolution: public readers see approved
 * nodes only; collaborators bypass the gate when stewardship is off; with
 * stewardship on, each node is gated via canUserAccess OR a share grant
 * covering it — so a doc/folder grantee's nodes survive the steward gate on a
 * governed nest (grants are read access independent of governance mode).
 */
export async function filterAccessible<T extends { id: string }>(
  nestId: string,
  userId: string,
  userEmail: string,
  nodes: T[],
  /** Approved versions already read by the caller, to avoid a second scan. */
  approvedVersions?: Map<string, number>,
): Promise<T[]> {
  if (await isPublicReader(nestId, userId)) {
    // One scan of the nest, not a sequential lookup per node — and none at all
    // when the caller has already read the map for its own use.
    const approved = approvedVersions ?? (await getApprovedVersions(nestId));
    return nodes.filter((n) => approved.has(n.id));
  }
  const grants = await listUserGrants(nestId, userId);
  if (!(await isStewardshipEnabled(nestId))) {
    // Stewardship off is open read for MEMBERS. A doc/folder grantee reaches
    // this nest with no nest-wide permission at all, so returning everything
    // would hand them the whole vault off a single shared document — narrow to
    // what their grants cover. The permission lookup only runs for grantees,
    // so members still pay one indexed query and nothing more.
    if (grants.length === 0) return nodes;
    if ((await resolveNestPermission(nestId, userId)) !== "none") return nodes;
    return nodes.filter((n) => grantCoversNode(grants, n.id));
  }
  const accessible: T[] = [];
  for (const n of nodes) {
    if (
      (await canUserAccess(nestId, n.id, userEmail)).allowed ||
      grantCoversNode(grants, n.id)
    ) {
      accessible.push(n);
    }
  }
  return accessible;
}
