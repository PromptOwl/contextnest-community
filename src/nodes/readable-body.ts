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
import { approvedOnlyForSurfaceEdit, surfaceEditsHiddenFor, hiddenSurfaceEdits, isHidden as isSurfaceHidden, anyHidden as anySurfaceHidden } from "../surfaces/draft-visibility.js";

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
  // A pending Surfaces edit (chat-derived draft) is served approved-only to
  // callers below write, like a public reader (security round 2, M1d).
  if (!(await isPublicReader(nestId, userId)) && !(await approvedOnlyForSurfaceEdit(nestId, nodeId, userId))) return workingBody;
  return approvedReadableBody(nestId, nodeId);
}

/** The approved version's body, or "" when there is none / it won't replay. */
export async function approvedReadableBody(nestId: string, nodeId: string): Promise<string> {
  return (await approvedBodyOrNull(nestId, nodeId)) ?? "";
}

/** The approved version's body, or null when there is none / it won't replay. */
export async function approvedBodyOrNull(nestId: string, nodeId: string): Promise<string | null> {
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

/**
 * The instructions an agent runs on (security N6): its approved body —
 * resolveExportBody, which on an ungoverned nest is the working copy — except
 * while a Surfaces edit is pending on the agent document, when ONLY the
 * approved body counts: a chat-derived draft is never executed.
 */
export async function agentInstructionsBody(nestId: string, nodeId: string, workingBody: string): Promise<string | null> {
  if (isSurfaceHidden(await hiddenSurfaceEdits(nestId), nodeId)) return approvedBodyOrNull(nestId, nodeId);
  return resolveExportBody(nestId, nodeId, workingBody);
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

/**
 * For a caller below write, swap the working copy of every node with a
 * pending Surfaces edit for its approved body (security round 3, N4): the
 * one helper graph, views and tables use, the same rule as get/search.
 */
export async function swapSurfaceEditBodies<T extends { id: string; body?: string }>(nestId: string, userId: string, docs: T[]): Promise<T[]> {
  const edits = await surfaceEditsHiddenFor(nestId, userId);
  if (!anySurfaceHidden(edits)) return docs;
  return Promise.all(docs.map(async (d) => (isSurfaceHidden(edits, d.id) ? { ...d, body: await approvedReadableBody(nestId, d.id) } : d)));
}
