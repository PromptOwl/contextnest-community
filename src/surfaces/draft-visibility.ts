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
export const draftVisibilityTestHooks: { fail?: boolean } = {};

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
