/**
 * Pending Surfaces drafts stay invisible until a person approves them (PRD
 * §4.7, AC-JDG-13, V6; security round 2 M1):
 *  - a NEW document a listener proposed is not returned at all;
 *  - an EDIT a listener proposed never shows its draft text: readers are
 *    served the node's approved body instead of the working copy;
 * except to the nest's editors and admins (who review it).
 *
 * The hide row exists BEFORE the draft does (state `creating`, written by
 * proposal-service before it calls the propose helper), and it stays until
 * the review is actually resolved (a withdrawal keeps the item `pending`
 * until its cancel and discard both succeed).
 *
 * Fail closed: any error other than "the Surfaces tables don't exist"
 * hides everything from callers below `write`.
 *
 * Kept dependency-light so the access guard can call it without a cycle.
 */
import { getDb } from "../db/client.js";
import { resolveNestPermission, permissionLevel } from "../shared/access.js";

/** Marker: the hidden set couldn't be read — treat every node as hidden. */
export const HIDE_ALL = Symbol("hide-all");
export type HiddenSet = Set<string> & { [HIDE_ALL]?: true };

const HIDING_STATES = "('creating', 'pending')";

/** Tests only: force the next reads to fail (fail-closed check). */
export const draftVisibilityTestHooks: { fail?: boolean; failLookup?: boolean } = {};

function missingTable(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err);
  return /no such table|does not exist/i.test(m) && /surface_proposal_items/i.test(m);
}

async function load(nestId: string, op: "new" | "edit"): Promise<HiddenSet> {
  try {
    if (draftVisibilityTestHooks.fail) throw new Error("injected read failure");
    const col = op === "new" ? "node_id" : "COALESCE(target_node_id, node_id)";
    // A review a person already approved (e.g. in the web queue) stops hiding at
    // once; the purge sweep then settles the item's own state.
    const rows = (await getDb().all(
      `SELECT ${col} AS id FROM surface_proposal_items i WHERE nest_id = ? AND op = ? AND state IN ${HIDING_STATES} AND ${col} IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM review_requests r WHERE r.id = i.review_id AND r.status = 'approved')`,
      [nestId, op],
    )) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    if (missingTable(err)) return new Set();
    const all = new Set<string>() as HiddenSet;
    all[HIDE_ALL] = true;
    return all;
  }
}

/** New documents proposed from chat and not yet approved. */
export function hiddenSurfaceDrafts(nestId: string): Promise<HiddenSet> {
  return load(nestId, "new");
}

/** Existing documents with a pending chat-derived edit (serve them approved-only). */
export function hiddenSurfaceEdits(nestId: string): Promise<HiddenSet> {
  return load(nestId, "edit");
}

export function isHidden(set: HiddenSet, nodeId: string): boolean {
  return set[HIDE_ALL] === true || set.has(nodeId);
}

export function anyHidden(set: HiddenSet): boolean {
  return set[HIDE_ALL] === true || set.size > 0;
}

/** May this caller see pending Surfaces drafts in this nest (write or above)? */
export async function seesSurfaceDrafts(nestId: string, userId: string): Promise<boolean> {
  try {
    return permissionLevel(await resolveNestPermission(nestId, userId)) >= permissionLevel("write");
  } catch {
    return false;
  }
}

/** Must this caller be served `nodeId`'s APPROVED body (a pending Surfaces edit)? */
export async function approvedOnlyForSurfaceEdit(nestId: string, nodeId: string, userId: string): Promise<boolean> {
  const edits = await hiddenSurfaceEdits(nestId);
  if (!isHidden(edits, nodeId)) return false;
  return !(await seesSurfaceDrafts(nestId, userId));
}

/** The node ids this caller must be served approved-only (empty for editors). */
export async function surfaceEditsHiddenFor(nestId: string, userId: string): Promise<HiddenSet> {
  const edits = await hiddenSurfaceEdits(nestId);
  if (!anyHidden(edits)) return edits;
  return (await seesSurfaceDrafts(nestId, userId)) ? new Set() : edits;
}

/**
 * Round 4 (Misha, 2026-11-01): a personal (DM) nest Surfaces created belongs
 * to its owner for review — only they may approve, reject or edit its drafts,
 * on every path. The marker is the surface_personal_nests row. A database
 * without the Surfaces tables has no personal nests.
 */
export interface PersonalNestOwner {
  userId: string;
  email: string;
  name: string;
}

/** An owner nobody matches: what a failed lookup yields (fail closed). */
const UNKNOWN_OWNER: PersonalNestOwner = { userId: "\u0000unknown", email: "\u0000unknown", name: "the owner" };

/**
 * The owner of a Surfaces personal nest, or null for any other nest. Fails
 * CLOSED (re-review N1): only a database WITHOUT the Surfaces tables means
 * "not personal"; any other error treats the nest as personal with an
 * unknown owner, so nobody may review for that call. Logs counts only.
 */
export async function surfacesPersonalOwner(nestId: string): Promise<PersonalNestOwner | null> {
  try {
    if (draftVisibilityTestHooks.failLookup) throw new Error("injected lookup failure");
    const r = (await getDb().get(
      "SELECT u.id, u.email, u.name FROM surface_personal_nests p JOIN users u ON u.id = p.community_user_id WHERE p.nest_id = ? LIMIT 1",
      [nestId],
    )) as { id: string; email: string; name: string | null } | undefined;
    if (r) return { userId: r.id, email: r.email, name: r.name?.trim() || r.email };
    // A marker whose owner row is gone stays personal (no owner can act).
    const orphan = await getDb().get("SELECT 1 AS x FROM surface_personal_nests WHERE nest_id = ? LIMIT 1", [nestId]);
    return orphan ? UNKNOWN_OWNER : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/no such table|does not exist/i.test(msg)) return null;
    console.error("[surfaces] personal-nest lookup failed; failing closed (1)");
    return UNKNOWN_OWNER;
  }
}

export const personalNestRefusal = (owner: PersonalNestOwner) => `Only ${owner.name} can review items in their private nest`;
