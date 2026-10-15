/**
 * Shared resolution of the body a caller is permitted to read.
 *
 * Public readers may only ever see a node's APPROVED version body — never
 * the on-disk working copy, which can hold unapproved draft edits. For
 * collaborators/stewards the working body is authoritative. Callers must
 * have already gated the node (filterAccessible / canReadNode); this only
 * swaps in the approved bytes for public readers so the single-node read,
 * `/context`, and `/export` can't drift on what a public agent sees.
 */
import { engineCache } from "./engine.js";
import { bodyOnly } from "./service.js";
import { isPublicReader } from "../shared/access.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { getApprovedVersion, getApprovedVersions } from "../governance/version-service.js";
import { reconstructApproved } from "../governance/approved-body.js";
import { liveVersions } from "../governance/access-log.js";

/** The version resolveReadableBody serves each node at, for the activity log. */
export async function readableVersions(
  nestId: string,
  userId: string,
  nodes: Array<{ id: string; frontmatter: { version?: unknown } }>,
): Promise<Record<string, number | null>> {
  if (!(await isPublicReader(nestId, userId))) return liveVersions(nodes);
  const approved = await getApprovedVersions(nestId);
  return Object.fromEntries(nodes.map((n) => [n.id, approved.get(n.id) ?? null]));
}

export async function resolveReadableBody(
  nestId: string,
  nodeId: string,
  userId: string,
  workingBody: string,
): Promise<string> {
  if (!(await isPublicReader(nestId, userId))) return workingBody;
  const approved = await getApprovedVersion(nestId, nodeId);
  if (approved == null) return "";
  try {
    const { versions } = await engineCache.get(nestId);
    const { raw } = await reconstructApproved(versions, nestId, nodeId, approved);
    return bodyOnly(nodeId, raw);
  } catch {
    return "";
  }
}

/**
 * Body for the nest EXPORT — approved-only for EVERY caller (owner, steward,
 * public). Drafts never leave via export, regardless of role.
 *
 * - Governed nest: return the approved version's body, or `null` when the node
 *   has no approved version yet (caller-agnostic — the node is dropped).
 * - Ungoverned nest: no approval workflow exists, so the working copy IS the
 *   published state — return it as-is.
 */
export async function resolveExportBody(
  nestId: string,
  nodeId: string,
  workingBody: string,
): Promise<string | null> {
  if (!(await isStewardshipEnabled(nestId))) return workingBody;
  const approved = await getApprovedVersion(nestId, nodeId);
  if (approved == null) return null;
  try {
    const { versions } = await engineCache.get(nestId);
    const { raw } = await reconstructApproved(versions, nestId, nodeId, approved);
    return bodyOnly(nodeId, raw);
  } catch {
    return null;
  }
}
