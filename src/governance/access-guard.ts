/**
 * Access Guard — gates node reads with canUserAccess when the nest has
 * stewardship enabled. No-op otherwise, so existing ungoverned nests are
 * unaffected.
 */

import { hiddenSurfaceDrafts, seesSurfaceDrafts, isHidden, anyHidden } from "../surfaces/draft-visibility.js";
import { getDb } from "../db/client.js";
import { isStewardshipEnabled } from "../nests/service.js";
import {
  canUserAccess,
  resolveStewardsForNode,
  resolveNestWideRoles,
  stewardCoverageForUser,
} from "./stewardship-service.js";
import { isPublicReader, resolveNestPermission } from "../shared/access.js";
import { getApprovedVersion, getApprovedVersions } from "./version-service.js";
import {
  resolveNodeGrant,
  listUserGrants,
  grantCoversNode,
  grantRoleForNode,
} from "./grants-service.js";
import { isChannelDoc, isChannelId, isChannelNode } from "../channels/channel-node.js";
import { ownsWorkingDraft, ownWorkingDraftIds } from "./org-contribution.js";
// Team chat harness C2 (PO-1197): conversations and private channels have a
// member list that decides reads; everything else keeps its usual rule.
import { containerReadVerdict, hiddenContainersFor, isConversationId } from "../chat/containers.js";
import { resolveNestAccess } from "../shared/access.js";

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
 * `canReadNode` for a caller known only by id: resolves the email so route
 * handlers don't each repeat the lookup. Use this at the route layer.
 */
export async function callerCanReadNode(
  nestId: string,
  nodeId: string,
  userId: string,
): Promise<boolean> {
  return canReadNode(nestId, nodeId, userId, await resolveCallerEmail(userId));
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
  // A pending Surfaces draft (a new document proposed from chat) is unseen
  // until approved, except by the nest's editors and admins (AC-JDG-13).
  if (isHidden(await hiddenSurfaceDrafts(nestId), nodeId) && !(await seesSurfaceDrafts(nestId, userId))) return false;
  // A conversation or a private channel (C2): the node's own shares decide
  // (its grants rows are its member list) — and the reader must still be a
  // person added to the nest, so a share outliving their access opens
  // nothing. A conversation's node is then readable on the share alone.
  const chat = await containerReadVerdict(nestId, nodeId, userId);
  if (chat === false) return false;
  if (chat === true) {
    const access = await resolveNestAccess(nestId, userId);
    const member = access.permission !== "none" && !access.isPublicReader;
    if (!member) return false;
    if (isConversationId(nodeId)) return true;
  }
  return canReadNodeBase(nestId, nodeId, userId, userEmail);
}

async function canReadNodeBase(
  nestId: string,
  nodeId: string,
  userId: string,
  userEmail: string,
): Promise<boolean> {
  if (await isPublicReader(nestId, userId)) {
    // Channels are members-only (PO-1190, AC-AX-10): someone who reaches the
    // nest only because it is public (or org-visible) never reads a channel
    // node, its purpose or its threads, approved or not.
    if (await isChannelNode(nestId, nodeId)) return false;
    return (
      (await getApprovedVersion(nestId, nodeId)) !== null ||
      (await seesOwnDraft(nestId, nodeId, userId, userEmail))
    );
  }
  if (!(await isStewardshipEnabled(nestId))) return true;
  if ((await canUserAccess(nestId, nodeId, userEmail)).allowed) return true;
  return (await resolveNodeGrant(nestId, userId, nodeId)) !== null;
}

/**
 * A visibility-only reader (org/public nest, no collaborator row) normally sees
 * approved content only. Two exceptions, both for ONE document: they hold a
 * `write` share grant on it (they can edit it, so they must see the draft they
 * edit), or its working copy is their own unreviewed draft (an org
 * contributor's proposal). Neither widens what they see elsewhere in the nest.
 */
export async function seesOwnDraft(
  nestId: string,
  nodeId: string,
  userId: string,
  userEmail: string,
): Promise<boolean> {
  if ((await resolveNodeGrant(nestId, userId, nodeId)) === "write") return true;
  return !!userEmail && (await ownsWorkingDraft(nestId, nodeId, userEmail));
}

/**
 * List form of `seesOwnDraft`: of `nodes`, the ids a visibility-only reader
 * sees as the live draft rather than the approved snapshot. Two queries for the
 * whole list, not one per node. Surfaces drafts stay hidden as in `canReadNode`.
 */
export async function ownDraftIds(
  nestId: string,
  userId: string,
  userEmail: string,
  nodes: Array<{ id: string }>,
): Promise<Set<string>> {
  const grants = (await listUserGrants(nestId, userId)).filter((g) => g.role === "write");
  const owned = userEmail ? await ownWorkingDraftIds(nestId, userEmail) : new Set<string>();
  const hidden = await hiddenSurfaceDrafts(nestId);
  const hideSurface = anyHidden(hidden) && !(await seesSurfaceDrafts(nestId, userId));
  return new Set(
    nodes
      .filter(
        (n) =>
          (owned.has(n.id) || grantRoleForNode(grants, n.id) === "write") &&
          !(hideSurface && isHidden(hidden, n.id)),
      )
      .map((n) => n.id),
  );
}

/**
 * May this caller ask for something to be deleted?
 *
 * Deletion — even only asking for one — is an editor's act. A viewer of any
 * kind (a `read` collaborator, a viewer steward, someone holding a read share
 * grant) has no business proposing that content disappear, so the action is
 * withheld from them entirely rather than offered and then refused.
 *
 * "Editor" is not one field: nest-wide `write`, an editor steward row covering
 * the target, or a `write` share grant on it all qualify — the same three
 * paths that let someone change the document in the first place.
 *
 * `nodeId` is the document for a per-node flag, or `""` for a folder/nest
 * flag — which requires a NEST-scope editor, not one scoped to some unrelated
 * document. Pass `permission` when the caller already resolved it (the REST
 * middleware promotes open-mode callers, which this would otherwise miss).
 *
 * Lives here, not in a route, so the REST and MCP paths share one rule — two
 * copies would drift, and the looser copy becomes the way in.
 */
export async function canRequestDeletion(params: {
  nestId: string;
  userId: string;
  userEmail: string;
  nodeId: string;
  permission?: string | null;
}): Promise<boolean> {
  const { nestId, userId, userEmail, nodeId } = params;
  const permission =
    params.permission ?? (await resolveNestPermission(nestId, userId));
  if (permission === "owner" || permission === "admin" || permission === "write") {
    return true;
  }
  const resolved = await resolveStewardsForNode(nestId, nodeId);
  const isEditorSteward = resolved.some(
    (r) =>
      r.steward.userEmail.toLowerCase() === userEmail.toLowerCase() &&
      r.steward.role === "editor" &&
      (nodeId !== "" || r.steward.scope === "nest"),
  );
  if (isEditorSteward) return true;
  if (nodeId === "") return false;
  return (await resolveNodeGrant(nestId, userId, nodeId)) === "write";
}

/**
 * True when the caller can read every document in the nest — the cases where
 * `filterAccessible` returns its input untouched, answered without listing the
 * nest. False means "possibly narrowed", not "narrowed": callers fall back to
 * `filterAccessible` for the exact set. Lets whole-nest views (folder tree,
 * comment counts) stay cheap for members and narrow only for restricted
 * callers. Keep in step with `filterAccessible` below.
 */
export async function readsWholeNest(
  nestId: string,
  userId: string,
  userEmail: string,
): Promise<boolean> {
  if (await isPublicReader(nestId, userId)) return false;
  if (!(await isStewardshipEnabled(nestId))) {
    if ((await listUserGrants(nestId, userId)).length === 0) return true;
    return (await resolveNestPermission(nestId, userId)) !== "none";
  }
  if ((await resolveNestWideRoles(nestId, userEmail)).length > 0) return true;
  return (await stewardCoverageForUser(nestId, userEmail)).nestWide;
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
  const hidden = await hiddenSurfaceDrafts(nestId);
  const visible =
    anyHidden(hidden) && nodes.some((n) => isHidden(hidden, n.id)) && !(await seesSurfaceDrafts(nestId, userId))
      ? nodes.filter((n) => !isHidden(hidden, n.id))
      : nodes;
  // Private channels and conversations this caller is not a member of are
  // not listed (C2): the node's shares are its member list.
  const hiddenChat = await hiddenContainersFor(nestId, userId, visible.map((n) => n.id));
  const shown = hiddenChat.size ? visible.filter((n) => !hiddenChat.has(n.id)) : visible;
  return filterAccessibleBase(nestId, userId, userEmail, shown, approvedVersions);
}

async function filterAccessibleBase<T extends { id: string }>(
  nestId: string,
  userId: string,
  userEmail: string,
  nodes: T[],
  approvedVersions?: Map<string, number>,
): Promise<T[]> {
  if (await isPublicReader(nestId, userId)) {
    // One scan of the nest, not a sequential lookup per node — and none at all
    // when the caller has already read the map for its own use.
    const approved = approvedVersions ?? (await getApprovedVersions(nestId));
    // …and never a channel (see canReadNodeBase). Only ids under
    // nodes/channels/ are looked at; a listing row carries its tags, anything
    // else is read once.
    const channels = new Set<string>();
    for (const n of nodes) {
      if (!isChannelId(n.id) || !approved.has(n.id)) continue;
      const fm = (n as { frontmatter?: { tags?: unknown } }).frontmatter;
      const tagged = Array.isArray(fm?.tags) ? isChannelDoc({ id: n.id, frontmatter: fm }) : await isChannelNode(nestId, n.id);
      if (tagged) channels.add(n.id);
    }
    return nodes.filter((n) => approved.has(n.id) && !channels.has(n.id));
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
  // Same rule as canUserAccess, resolved for the whole list instead of once
  // per node: view rights need ANY role, so a nest-wide role (owner, super,
  // collaborator, team) admits every document without touching steward rows.
  if ((await resolveNestWideRoles(nestId, userEmail)).length > 0) return nodes;
  const coverage = await stewardCoverageForUser(nestId, userEmail);
  if (coverage.nestWide) return nodes;
  return nodes.filter(
    (n) => coverage.nodeIds.has(n.id) || grantCoversNode(grants, n.id),
  );
}

/**
 * The deletion requests this caller may see. A request names what it targets
 * and carries who asked and why, so it follows its target: a document's
 * request is for callers who can read that document (`filterAccessible`), and
 * a folder's or the nest's own is for callers who read the whole nest.
 *
 * Lives here so the REST queue and MCP `context_deletion_queue` share one rule.
 */
export async function readableDeletionRequests<
  T extends { nodeId: string; targetType: string },
>(nestId: string, userId: string, userEmail: string, requests: T[]): Promise<T[]> {
  if (requests.length === 0) return requests;
  const documents = [
    ...new Set(requests.filter((r) => r.targetType === "document").map((r) => r.nodeId)),
  ].map((id) => ({ id }));
  const readable = new Set(
    (await filterAccessible(nestId, userId, userEmail, documents)).map((n) => n.id),
  );
  const whole =
    documents.length < requests.length &&
    requests.some((r) => r.targetType !== "document") &&
    (await readsWholeNest(nestId, userId, userEmail));
  return requests.filter((r) =>
    r.targetType === "document" ? readable.has(r.nodeId) : whole,
  );
}
