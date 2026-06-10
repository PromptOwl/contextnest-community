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
import { getApprovedVersion } from "../governance/version-service.js";

export async function resolveReadableBody(
  nestId: string,
  nodeId: string,
  userId: string,
  workingBody: string,
): Promise<string> {
  if (!isPublicReader(nestId, userId)) return workingBody;
  const approved = getApprovedVersion(nestId, nodeId);
  if (approved == null) return "";
  try {
    const { versions } = engineCache.get(nestId);
    const raw = await versions.reconstructVersion(nodeId, approved);
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
  if (!isStewardshipEnabled(nestId)) return workingBody;
  const approved = getApprovedVersion(nestId, nodeId);
  if (approved == null) return null;
  try {
    const { versions } = engineCache.get(nestId);
    const raw = await versions.reconstructVersion(nodeId, approved);
    return bodyOnly(nodeId, raw);
  } catch {
    return null;
  }
}
