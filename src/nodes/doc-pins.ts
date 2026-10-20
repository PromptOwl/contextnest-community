/**
 * Document pins (CU-wdqcq02crw) — experimental, behind EXPERIMENTAL_DOC_PINS.
 *
 * Two kinds of pin on one table (node_pins, migration 069):
 *   - editorial (scope 'nest'): the nest's own front page. A steward pins for
 *     everyone, in an order they choose. Who may: the nest owner, a nest admin,
 *     the server admin, or a nest-wide reviewer steward — the same curator set
 *     that may define custom fields (assertCanManageFields). A write
 *     collaborator is an author, not a curator, and is refused.
 *   - personal (scope 'user'): my own bookmark row, invisible to everyone else.
 *     Read access to the document is all it takes — the nest_pins rule one
 *     level down.
 *
 * Reads go through the same access rules as documents (filterAccessible), and
 * only documents still in the node index are returned, so a pin never hands out
 * a title the caller couldn't open or an id that no longer resolves.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { ensureNodeIndex } from "./node-index.js";
import { resolveNestAccess, isNestArchived } from "../shared/access.js";
import {
  getStewardsForUser,
  isUniqueViolation,
} from "../governance/stewardship-service.js";
import {
  canReadNode,
  filterAccessible,
  resolveCallerEmail,
} from "../governance/access-guard.js";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../shared/errors.js";

export type PinScope = "nest" | "user";

/** Most pins one list may hold — the editorial strip, or one person's own.
 *  GET returns every pin in a list, so the list has to stay bounded. */
export const MAX_PINS_PER_LIST = 50;

export interface DocPin {
  node_id: string;
  scope: PinScope;
  title: string;
  type: string;
  status: string;
  position: number;
  pinned_by: string | null;
  pinned_at: string;
}

export interface NestPins {
  editorial: DocPin[];
  personal: DocPin[];
  /** Whether the caller may pin for everyone / reorder — for the UI. */
  can_pin_editorial: boolean;
}

export function parseScope(raw: unknown): PinScope {
  if (raw === "nest" || raw === "user") return raw;
  throw new ValidationError('scope must be "nest" (pin for everyone) or "user" (pin for me)');
}

export function parseNodeId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ValidationError("node_id is required");
  }
  const id = raw.trim();
  // Same containment rule as every node route: an id is a storage path.
  if (id.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw new ValidationError("invalid node_id");
  }
  return id;
}

/**
 * Throws unless the caller may change editorial pins here. Mirrors
 * assertCanManageFields: open mode is the anonymous owner; an archived nest is
 * read-only for everyone.
 */
export async function assertCanCurate(nestId: string, userId: string): Promise<void> {
  if (config.AUTH_MODE === "open") {
    if (await isNestArchived(nestId)) {
      throw new ForbiddenError("This nest is archived, so it is read-only. Restore it to change its pins.");
    }
    return;
  }
  const access = await resolveNestAccess(nestId, userId);
  if (!access.exists) throw new NotFoundError("Nest not found");
  if (access.archived) {
    throw new ForbiddenError("This nest is archived, so it is read-only. Restore it to change its pins.");
  }
  if (access.rawPermission === "owner" || access.rawPermission === "admin") return;
  if (access.callerEmail) {
    const rows = await getStewardsForUser(nestId, access.callerEmail);
    if (rows.some((s) => s.role === "reviewer" && s.scope === "nest")) return;
  }
  throw new ForbiddenError(
    "Only the nest owner, a nest admin, the server admin or a nest-wide reviewer steward can pin documents for everyone.",
  );
}

async function canCurate(nestId: string, userId: string): Promise<boolean> {
  try {
    await assertCanCurate(nestId, userId);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof NotFoundError) return false;
    throw err;
  }
}

/** The document must exist and the caller must be able to read it — else 404,
 *  the same answer for both so a pin is not an existence oracle. */
async function assertReadableDocument(nestId: string, nodeId: string, userId: string): Promise<void> {
  await ensureNodeIndex(nestId);
  const row = await getDb().get(
    "SELECT 1 FROM node_index WHERE nest_id = ? AND node_id = ?",
    [nestId, nodeId],
  );
  const email = await resolveCallerEmail(userId);
  if (!row || !(await canReadNode(nestId, nodeId, userId, email))) {
    throw new NotFoundError(`Document not found: ${nodeId}`);
  }
}

interface PinRow {
  node_id: string;
  scope: PinScope;
  position: number | string;
  pinned_by: string | null;
  created_at: string;
  title: string;
  type: string;
  status: string;
}

/**
 * Every pin the caller may see in this nest: the editorial strip in its chosen
 * order, then the caller's own. One query per list, joined to node_index so a
 * row whose document is gone is never returned.
 */
export async function listPins(nestId: string, userId: string | undefined): Promise<NestPins> {
  await ensureNodeIndex(nestId);
  const db = getDb();
  const select = `SELECT p.node_id, p.scope, p.position, p.pinned_by, p.created_at,
                         i.title, i.type, i.status
                    FROM node_pins p
                    JOIN node_index i ON i.nest_id = p.nest_id AND i.node_id = p.node_id`;
  const editorialRows = (await db.all(
    `${select} WHERE p.nest_id = ? AND p.scope = 'nest' ORDER BY p.position, p.created_at, p.node_id`,
    [nestId],
  )) as PinRow[];
  const personalRows = userId
    ? ((await db.all(
        `${select} WHERE p.nest_id = ? AND p.scope = 'user' AND p.user_id = ?
          ORDER BY p.position, p.created_at, p.node_id`,
        [nestId, userId],
      )) as PinRow[])
    : [];

  const toPin = (r: PinRow): DocPin & { id: string } => ({
    id: r.node_id,
    node_id: r.node_id,
    scope: r.scope,
    title: r.title || r.node_id,
    type: r.type,
    status: r.status,
    position: Number(r.position),
    pinned_by: r.pinned_by,
    pinned_at: r.created_at,
  });
  const email = await resolveCallerEmail(userId);
  const curator = userId ? await canCurate(nestId, userId) : false;
  // pinned_by is an email. Curators manage the strip and already see the
  // roster; a reader or a document grantee can't otherwise list the nest's
  // members, so it is withheld from them.
  const visible = async (rows: PinRow[]) =>
    (await filterAccessible(nestId, userId ?? "", email, rows.map(toPin))).map(
      ({ id: _id, ...pin }) => (curator ? pin : { ...pin, pinned_by: null }),
    );

  return {
    editorial: await visible(editorialRows),
    personal: await visible(personalRows),
    can_pin_editorial: curator,
  };
}

/**
 * Pin a document. Idempotent: pinning what is already pinned returns the
 * existing pin. A new pin goes to the END of its list.
 */
export async function pinDocument(params: {
  nestId: string;
  nodeId: string;
  scope: PinScope;
  userId: string;
}): Promise<{ pin: DocPin; created: boolean }> {
  const { nestId, nodeId, scope, userId } = params;
  if (scope === "nest") await assertCanCurate(nestId, userId);
  await assertReadableDocument(nestId, nodeId, userId);

  const db = getDb();
  const owner = scope === "user" ? userId : null;
  const existing = async () =>
    (await db.get(
      `SELECT node_id, scope, position, pinned_by, created_at FROM node_pins
        WHERE nest_id = ? AND node_id = ? AND scope = ?
          AND ${owner === null ? "user_id IS NULL" : "user_id = ?"}`,
      owner === null ? [nestId, nodeId, scope] : [nestId, nodeId, scope, owner],
    )) as Omit<PinRow, "title" | "type" | "status"> | undefined;

  const listWhere = `nest_id = ? AND scope = ? AND ${owner === null ? "user_id IS NULL" : "user_id = ?"}`;
  const listParams = owner === null ? [nestId, scope] : [nestId, scope, owner];
  let created = false;
  if (!(await existing())) {
    const capped = () =>
      new ValidationError(
        `A nest can hold at most ${MAX_PINS_PER_LIST} ${scope === "nest" ? "pins for everyone" : "of your own pins"} — unpin one first.`,
      );
    try {
      // One statement does the cap check, the position and the insert: the
      // new pin lands after whatever is there at that moment, and HAVING
      // refuses it when the list is already full (no row → changes 0). On
      // SQLite (one writer) that is exact; on Postgres READ COMMITTED two
      // inserts racing can still tie on position or overshoot the cap by the
      // racers — reads order by (position, created_at, node_id), so a tie is
      // deterministic and the next reorder rewrites it.
      const r = await db.run(
        `INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position, pinned_by)
         SELECT ?, ?, ?, ?, ?, COALESCE(MAX(position), -1) + 1, ?
           FROM node_pins WHERE ${listWhere}
         HAVING COUNT(*) < ?`,
        [randomUUID(), nestId, nodeId, scope, owner, await resolveCallerEmail(userId), ...listParams, MAX_PINS_PER_LIST],
      );
      if (r.changes === 0) throw capped();
      created = true;
    } catch (err) {
      // Two clicks racing: the loser trips the partial unique index. The pin
      // exists, which is what the caller asked for.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  const row = await existing();
  // Unpinned by someone else between our insert and this read — the pin the
  // caller asked for is gone, so say so rather than 500.
  if (!row) throw new NotFoundError(`Document is no longer pinned: ${nodeId}`);
  const meta = (await db.get(
    "SELECT title, type, status FROM node_index WHERE nest_id = ? AND node_id = ?",
    [nestId, nodeId],
  )) as { title: string; type: string; status: string } | undefined;
  return {
    created,
    pin: {
      node_id: row.node_id,
      scope: row.scope,
      title: meta?.title || nodeId,
      type: meta?.type ?? "document",
      status: meta?.status ?? "draft",
      position: Number(row.position),
      pinned_by: row.pinned_by,
      pinned_at: row.created_at,
    },
  };
}

/** Remove a pin. Idempotent — returns whether a row was removed. */
export async function unpinDocument(params: {
  nestId: string;
  nodeId: string;
  scope: PinScope;
  userId: string;
}): Promise<boolean> {
  const { nestId, nodeId, scope, userId } = params;
  if (scope === "nest") {
    await assertCanCurate(nestId, userId);
    const r = await getDb().run(
      "DELETE FROM node_pins WHERE nest_id = ? AND node_id = ? AND scope = 'nest'",
      [nestId, nodeId],
    );
    return r.changes > 0;
  }
  const r = await getDb().run(
    "DELETE FROM node_pins WHERE nest_id = ? AND node_id = ? AND scope = 'user' AND user_id = ?",
    [nestId, nodeId, userId],
  );
  return r.changes > 0;
}

/**
 * Reorder the editorial strip. `nodeIds` must name every editorial pin exactly
 * once — a partial list would leave the unnamed pins' positions ambiguous, and
 * a stale client (someone else pinned meanwhile) should be told, not silently
 * merged.
 */
export async function reorderEditorialPins(params: {
  nestId: string;
  nodeIds: unknown;
  userId: string;
}): Promise<void> {
  const { nestId, userId } = params;
  await assertCanCurate(nestId, userId);
  if (!Array.isArray(params.nodeIds) || params.nodeIds.some((x) => typeof x !== "string")) {
    throw new ValidationError("node_ids must be an array of document ids");
  }
  const nodeIds = params.nodeIds as string[];
  const db = getDb();
  await ensureNodeIndex(nestId);
  // Validate and write in one transaction, so a pin added or removed between
  // the check and the writes can't slip past "every pin exactly once".
  await db.transaction(async (tx) => {
    // Only pins whose document still exists — the set GET can return. A row
    // whose document vanished outside the app (no delete hook ran) is
    // invisible to every client, so demanding it here would make every
    // reorder a 400.
    const current = (await tx.all(
      `SELECT p.node_id FROM node_pins p
         JOIN node_index i ON i.nest_id = p.nest_id AND i.node_id = p.node_id
        WHERE p.nest_id = ? AND p.scope = 'nest'`,
      [nestId],
    )) as Array<{ node_id: string }>;
    const have = new Set(current.map((r) => r.node_id));
    const given = new Set(nodeIds);
    if (
      given.size !== nodeIds.length ||
      given.size !== have.size ||
      nodeIds.some((id) => !have.has(id))
    ) {
      throw new ValidationError(
        "node_ids must list every editorial pin exactly once (reload the pins and try again)",
      );
    }
    // Dangling rows sink behind the real ones rather than keeping a slot.
    await tx.run(
      "UPDATE node_pins SET position = ? WHERE nest_id = ? AND scope = 'nest'",
      [nodeIds.length, nestId],
    );
    for (let i = 0; i < nodeIds.length; i++) {
      await tx.run(
        "UPDATE node_pins SET position = ? WHERE nest_id = ? AND node_id = ? AND scope = 'nest'",
        [i, nestId, nodeIds[i]],
      );
    }
  });
}

/**
 * Drop someone's personal pins in a nest once they no longer reach it — the
 * one rule for leaving and for being removed. Revoking a team share or a
 * document/folder grant does NOT call this: the pins linger, but listPins'
 * read filter hides every document the person can no longer read, so nothing
 * leaks; they go when the person leaves or the document is deleted. Someone who still reaches the
 * nest (a team share, a document/folder grant, its visibility) keeps their
 * bookmarks; the read filter already hides any pinned document they lost.
 * Runs after the access change has committed, so the check sees it.
 */
export async function dropPersonalPinsIfGone(nestId: string, userId: string): Promise<void> {
  const access = await resolveNestAccess(nestId, userId);
  if (access.exists && (access.permission !== "none" || access.hasGrant)) return;
  await getDb().run(
    "DELETE FROM node_pins WHERE nest_id = ? AND scope = 'user' AND user_id = ?",
    [nestId, userId],
  );
}
