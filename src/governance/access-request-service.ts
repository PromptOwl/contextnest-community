/**
 * Access requests (CU-wdqcq041jn) — what a refused write turns into.
 *
 * Someone who can SEE a document, a folder or the nest but not change it used
 * to get a bare 403. Now the refusal says they may ask (see
 * `accessRequestHint`, attached by the nest middleware and the MCP write
 * tools), the ask is one row here, and the nest owner/admins decide it from
 * their inbox. Approving grants through the paths that already exist:
 *   - a document → a `write` share grant on it (grants-service)
 *   - a folder   → a `write` share grant on the folder prefix
 *   - the nest   → nest collaborator at that level (sharing-service), or an
 *                  upgrade of the row they already hold
 * so nothing here invents a new kind of permission — revoking is the ordinary
 * share/collaborator removal.
 *
 * Hidden nests stay hidden: asking requires being able to see the target, and
 * an unseen one answers 404 exactly like a read would.
 *
 * Exported for other server features (agent personas file a request instead
 * of failing): `createAccessRequest`, `accessRequestHint`.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import type { SqlParam } from "../db/adapter.js";
import { nowExpr, nowMsExpr } from "../db/sql.js";
import { config } from "../config.js";
import { ANON_USER_ID } from "../shared/constants.js";
import { AppError, NotFoundError, ValidationError } from "../shared/errors.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import {
  permissionLevel,
  resolveNestAccess,
  type NestPermission,
} from "../shared/access.js";
import { engineCache } from "../nodes/engine.js";
import { isIdUnderFolder } from "../nodes/service.js";
import { canReadNode, filterAccessible } from "./access-guard.js";
import { createGrant, resolveNodeGrant } from "./grants-service.js";
import { canManageStewards, resolveStewardsForNode } from "./stewardship-service.js";
import { addCollaborator } from "../nests/sharing-service.js";
import { assertCanGrant, permissionClass } from "../auth/seats.js";
import { inboxInsert, nestAdminEmails } from "./review-service.js";
import { markNotificationsReadBySubject } from "./notify-service.js";
import {
  buildDocContext,
  buildTitleMap,
  nestName,
  prettyFolderPath,
  titleForNode,
} from "./title-resolver.js";
import { dispatchEvent } from "../notify/dispatch.js";
import { personaHomeNests } from "../metacognition/store.js";
import { notifyNestEvent } from "../notify/notify.js";
import { sendEmailToRecipient } from "../notify/email.js";

export type AccessTargetType = "node" | "folder" | "nest";
export type AccessLevel = "read" | "write";
export type AccessRequestStatus = "pending" | "approved" | "denied";

export interface AccessTarget {
  type: AccessTargetType;
  /** A node id, a folder path ("gtm/deals"), or the nest id. */
  id: string;
}

export interface AccessRequest {
  id: string;
  nest_id: string;
  requester_id: string;
  requested_by: string;
  target_type: AccessTargetType;
  target_id: string;
  level: AccessLevel;
  note: string | null;
  status: AccessRequestStatus;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  /** Human label: the document title, the folder path, or the nest name. */
  title?: string;
}

const TARGET_TYPES: readonly AccessTargetType[] = ["node", "folder", "nest"];
const LEVELS: readonly AccessLevel[] = ["read", "write"];
const MAX_NOTE = 2000;
/** How long a denial stands before the same person may ask for the same
 *  target again. */
export const ASK_AGAIN_AFTER_MS = 60 * 60 * 1000;

/** How many requests one person may have pending in one nest at a time. */
export const MAX_PENDING_PER_NEST = 10;

/**
 * When a denied request may be asked again (ISO), or null when it already
 * may — so a client can say "ask again after …" instead of offering a button
 * that 429s. Display only: createAccessRequest decides in SQL.
 */
export function canAskAgainAt(r: Pick<AccessRequest, "status" | "resolved_at">): string | null {
  if (r.status !== "denied" || !r.resolved_at) return null;
  const at = parseSqlTime(r.resolved_at) + ASK_AGAIN_AFTER_MS;
  return Number.isFinite(at) && at > Date.now() ? new Date(at).toISOString() : null;
}

/** A Date as the 'YYYY-MM-DD HH:MM:SS' UTC text nowExpr stores. */
function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Parse that text (or an ISO string, with or without a zone) as UTC ms. */
function parseSqlTime(v: string): number {
  const iso = v.includes("T") ? v : v.replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

/** 429: asked again too soon after a denial. */
export class TooSoonError extends AppError {
  constructor(public minutes: number) {
    super(
      429,
      `This request was denied recently. You can ask again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    );
    this.name = "TooSoonError";
  }
}

/** Normalize a target the way every caller names it, so "gtm/deals",
 *  "/gtm/deals/" and "nodes/gtm/deals" land on one pending row. */
export function normalizeAccessTarget(
  nestId: string,
  type: unknown,
  id: unknown,
): AccessTarget {
  if (!TARGET_TYPES.includes(type as AccessTargetType)) {
    throw new ValidationError('target_type must be "node", "folder" or "nest"');
  }
  if (type === "nest") return { type, id: nestId };
  const raw = typeof id === "string" ? id.trim() : "";
  if (!raw) throw new ValidationError("target_id is required");
  if (type === "node") return { type, id: assertSafeNodeId(raw) };
  const folder = raw.replace(/^\/+|\/+$/g, "").replace(/^nodes\//, "");
  if (!folder || folder === "nodes") {
    throw new ValidationError("target_id must name a folder, not the nest root — ask for the nest instead");
  }
  for (const seg of folder.split("/")) {
    if (!seg || seg === "." || seg === "..") throw new ValidationError("invalid folder");
  }
  return { type: "folder", id: folder };
}

/** Human label for a target, for the queue, inbox rows and emails. */
export async function accessTargetTitle(
  nestId: string,
  target: AccessTarget,
): Promise<string> {
  if (target.type === "folder") return prettyFolderPath(target.id);
  if (target.type === "nest") return await nestName(nestId);
  return await titleForNode(nestId, target.id);
}

/** Can this caller see the target at all? The 404 line: asking about
 *  something you can't see must not confirm it exists. */
async function canSeeTarget(
  nestId: string,
  userId: string,
  userEmail: string,
  target: AccessTarget,
): Promise<boolean> {
  const access = await resolveNestAccess(nestId, userId);
  if (access.permission === "none" && !access.hasGrant) return false;
  if (target.type === "nest") return true;
  const { storage } = await engineCache.get(nestId);
  const docs = await storage.discoverDocuments();
  if (target.type === "node") {
    if (!docs.some((d) => d.id === target.id)) return false;
    // A grantee with no nest permission reaches only what their shares cover.
    if (access.permission === "none") {
      return (await resolveNodeGrant(nestId, userId, target.id)) !== null;
    }
    return await canReadNode(nestId, target.id, userId, userEmail);
  }
  const inside = docs.filter((d) => isIdUnderFolder(d.id, target.id));
  if (inside.length === 0) return false;
  return (await filterAccessible(nestId, userId, userEmail, inside)).length > 0;
}

/** A persona has no nest role of its own; in its home nest it may ask about
 *  any document or folder that exists (its owner, an admin, can see them all). */
async function personaSeesTarget(nestId: string, target: AccessTarget): Promise<boolean> {
  const { storage } = await engineCache.get(nestId);
  const docs = await storage.discoverDocuments();
  if (target.type === "node") return docs.some((d) => d.id === target.id);
  return docs.some((d) => isIdUnderFolder(d.id, target.id));
}

/** Does the caller already hold `level` on the target? Then there's nothing
 *  to ask for, and the request would only clutter an admin's inbox. */
async function alreadyHolds(
  nestId: string,
  userId: string,
  userEmail: string,
  target: AccessTarget,
  level: AccessLevel,
): Promise<boolean> {
  if (config.AUTH_MODE === "open") return true;
  const { permission } = await resolveNestAccess(nestId, userId);
  if (permissionLevel(permission) >= permissionLevel(level)) return true;
  if (target.type === "nest") return false;
  const nodeKey = target.type === "node" ? target.id : `nodes/${target.id}`;
  const grant = await resolveNodeGrant(nestId, userId, nodeKey);
  if (grant && permissionLevel(grant) >= permissionLevel(level)) return true;
  if (target.type === "node" && level === "write") {
    // An editor steward row covering the document already lets them edit it.
    const rows = await resolveStewardsForNode(nestId, target.id);
    return rows.some(
      (r) =>
        r.steward.role === "editor" &&
        r.steward.userEmail.toLowerCase() === userEmail.toLowerCase(),
    );
  }
  return false;
}

function rowToRequest(row: any): AccessRequest {
  return {
    id: row.id,
    nest_id: row.nest_id,
    requester_id: row.requester_id,
    requested_by: row.requested_by,
    target_type: row.target_type,
    target_id: row.target_id,
    level: row.level,
    note: row.note ?? null,
    status: row.status,
    created_at: row.created_at,
    resolved_by: row.resolved_by ?? null,
    resolved_at: row.resolved_at ?? null,
    resolution_note: row.resolution_note ?? null,
  };
}

export async function getAccessRequest(id: string): Promise<AccessRequest | null> {
  const row = await getDb().get("SELECT * FROM access_requests WHERE id = ?", [id]);
  return row ? rowToRequest(row) : null;
}

/** The caller's most recent request for this target, whatever its state —
 *  what a refusal and the "Request access" prompt show. */
export async function latestAccessRequest(
  nestId: string,
  requesterId: string,
  target: AccessTarget,
): Promise<AccessRequest | null> {
  const row = await getDb().get(
    `SELECT * FROM access_requests
      WHERE nest_id = ? AND requester_id = ? AND target_type = ? AND target_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [nestId, requesterId, target.type, target.id],
  );
  return row ? rowToRequest(row) : null;
}

/** Who is asking: a person, a metacognition persona (in `nestId`, its home),
 *  or someone who may never ask. */
type Requester = "person" | "persona" | null;

/** Callers who may never ask: no account (open-mode anonymous / signed-out
 *  public reader) and headless access keys, which are read-only by design. A
 *  metacognition persona may ask, but only in the nest it lives in — that is
 *  where an admin decides what it reaches. */
async function requesterKind(userId: string | undefined, nestId: string): Promise<Requester> {
  if (!userId || userId === ANON_USER_ID) return null;
  const row = (await getDb().get(
    "SELECT COALESCE(is_service, 0) AS svc FROM users WHERE id = ?",
    [userId],
  )) as { svc: number } | undefined;
  if (!row) return null;
  if (!row.svc) return "person";
  return (await personaHomeNests(userId)).includes(nestId) ? "persona" : null;
}

async function isEligibleRequester(userId: string | undefined, nestId: string): Promise<boolean> {
  return (await requesterKind(userId, nestId)) === "person";
}

/**
 * What a refused write adds to its 403 body when the caller could ask for the
 * access instead: `{ code, can_request_access, target, level }`, plus the
 * caller's latest request for that target when it is pending (so the client
 * says "Request pending" instead of offering a second ask) or denied (so they
 * see the answer and the note). Null when this caller can't ask at all.
 */
export async function accessRequestHint(params: {
  nestId: string;
  userId: string | undefined;
  target: AccessTarget;
  level?: AccessLevel;
}): Promise<Record<string, unknown> | null> {
  const { nestId, userId, target } = params;
  if (!(await isEligibleRequester(userId, nestId))) return null;
  const level = params.level ?? "write";
  const latest = await latestAccessRequest(nestId, userId!, target);
  return {
    code: "forbidden",
    can_request_access: true,
    target: { type: target.type, id: target.id },
    level,
    ...(latest && latest.status !== "approved"
      ? {
          access_request: {
            id: latest.id,
            status: latest.status,
            created_at: latest.created_at,
            resolved_by: latest.resolved_by,
            resolved_at: latest.resolved_at,
            resolution_note: latest.resolution_note,
            can_ask_again_at: canAskAgainAt(latest),
          },
        }
      : {}),
  };
}

/**
 * File an access request. Returns the existing pending one (created: false)
 * rather than a second row when the caller already asked for this target.
 * Throws NotFoundError when the caller can't see the target, ValidationError
 * when they already hold the access or can't ask, TooSoonError within
 * ASK_AGAIN_AFTER_MS of a denial for the same target.
 */
export async function createAccessRequest(params: {
  nestId: string;
  requesterId: string;
  requesterEmail: string;
  targetType: unknown;
  targetId?: unknown;
  level?: unknown;
  note?: unknown;
  /** Request origin, for the notification links. */
  baseUrl?: string;
}): Promise<{ request: AccessRequest; created: boolean }> {
  const { nestId, requesterId, requesterEmail } = params;
  const target = normalizeAccessTarget(nestId, params.targetType, params.targetId);
  const level = (params.level ?? "write") as AccessLevel;
  if (!LEVELS.includes(level)) throw new ValidationError('level must be "read" or "write"');
  const note =
    typeof params.note === "string" && params.note.trim()
      ? params.note.trim().slice(0, MAX_NOTE)
      : null;

  const kind = await requesterKind(requesterId, nestId);
  if (!kind) {
    throw new ValidationError("Sign in to request access.");
  }
  // A persona asks for a document or a folder to work on, never the nest: a
  // nest-wide grant would make it a collaborator, and its home nest is
  // already where it lives.
  if (kind === "persona" && target.type === "nest") {
    throw new ValidationError("An agent asks for a document or a folder, not the whole nest.");
  }
  const visible =
    kind === "persona"
      ? await personaSeesTarget(nestId, target)
      : await canSeeTarget(nestId, requesterId, requesterEmail, target);
  if (!visible) {
    throw new NotFoundError(
      target.type === "nest" ? "Nest not found" : `${target.type === "node" ? "Node" : "Folder"} not found`,
    );
  }
  const access = await resolveNestAccess(nestId, requesterId);
  if (access.archived) {
    throw new ValidationError("This nest is archived, so it is read-only. Ask an owner to restore it.");
  }
  if (await alreadyHolds(nestId, requesterId, requesterEmail, target, level)) {
    throw new ValidationError(`You already have ${level} access to this ${target.type === "node" ? "document" : target.type}.`);
  }

  const db = getDb();
  const pending = await db.get(
    `SELECT * FROM access_requests
      WHERE nest_id = ? AND requester_id = ? AND target_type = ? AND target_id = ?
        AND status = 'pending'`,
    [nestId, requesterId, target.type, target.id],
  );
  if (pending) return { request: rowToRequest(pending), created: false };

  // Dedup is per target, so cap how many different asks one person can have
  // waiting in a nest: each one emails every admin.
  const open = (await db.get(
    "SELECT COUNT(*) AS n FROM access_requests WHERE nest_id = ? AND requester_id = ? AND status = 'pending'",
    [nestId, requesterId],
  )) as { n: number | string };
  if (Number(open.n) >= MAX_PENDING_PER_NEST) {
    throw new AppError(
      429,
      `You already have ${MAX_PENDING_PER_NEST} access requests waiting in this nest. Wait for an answer, or ask for the folder or the whole nest instead.`,
    );
  }

  // A "no" holds for a while: without this, someone denied could re-file on
  // every refused save and fill the admins' inboxes and email with the same ask.
  // Decided in SQL against a cutoff in the column's own format ('YYYY-MM-DD
  // HH:MM:SS', UTC — nowExpr on both backends), so a timestamp JS can't parse
  // can never switch the cooldown off; the clock only shapes the message.
  // The text comparison relies on resolved_at staying in that second-
  // resolution format (decideAccessRequest writes it with nowExpr).
  const cutoff = sqlTime(new Date(Date.now() - ASK_AGAIN_AFTER_MS));
  const recentDenial = (await db.get(
    `SELECT resolved_at FROM access_requests
      WHERE nest_id = ? AND requester_id = ? AND target_type = ? AND target_id = ?
        AND status = 'denied' AND resolved_at > ?
      ORDER BY resolved_at DESC LIMIT 1`,
    [nestId, requesterId, target.type, target.id, cutoff],
  )) as { resolved_at: string } | undefined;
  if (recentDenial) {
    const deniedAt = parseSqlTime(recentDenial.resolved_at);
    const minutes = Number.isFinite(deniedAt)
      ? Math.max(1, Math.ceil((deniedAt + ASK_AGAIN_AFTER_MS - Date.now()) / 60_000))
      : Math.round(ASK_AGAIN_AFTER_MS / 60_000);
    throw new TooSoonError(minutes);
  }

  const id = uuid();
  try {
    // Millisecond created_at keeps "latest" exact when someone asks again
    // moments after a denial.
    await db.run(
      `INSERT INTO access_requests
         (id, nest_id, requester_id, requested_by, target_type, target_id, level, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${nowMsExpr(db)})`,
      [
        id,
        nestId,
        requesterId,
        requesterEmail.toLowerCase(),
        target.type,
        target.id,
        level,
        note,
      ],
    );
  } catch (err) {
    // Two asks racing past the check above: the partial unique index lets one
    // in, and the other answers with the row that won.
    const winner = await db.get(
      `SELECT * FROM access_requests
        WHERE nest_id = ? AND requester_id = ? AND target_type = ? AND target_id = ?
          AND status = 'pending'`,
      [nestId, requesterId, target.type, target.id],
    );
    if (winner) return { request: rowToRequest(winner), created: false };
    throw err;
  }
  const request = (await getAccessRequest(id))!;
  await notifyAccessRequested(request, params.baseUrl);
  return { request, created: true };
}

export async function listAccessRequests(params: {
  /** Newest first, at most this many (default 200). */
  limit?: number;
  nestId?: string;
  /** Cross-nest scope for the /me/work inbox — the caller's visible nests. */
  nestIds?: string[];
  status?: AccessRequestStatus | "all";
  /** Only this requester's own requests. */
  requesterId?: string;
}): Promise<AccessRequest[]> {
  const where: string[] = [];
  const args: SqlParam[] = [];
  if (params.nestId) {
    where.push("nest_id = ?");
    args.push(params.nestId);
  }
  if (params.nestIds) {
    if (params.nestIds.length === 0) return [];
    where.push(`nest_id IN (${params.nestIds.map(() => "?").join(",")})`);
    args.push(...params.nestIds);
  }
  const status = params.status ?? "pending";
  if (status !== "all") {
    where.push("status = ?");
    args.push(status);
  }
  if (params.requesterId) {
    where.push("requester_id = ?");
    args.push(params.requesterId);
  }
  const rows = (await getDb().all(
    `SELECT * FROM access_requests${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ${Math.min(Math.max(Math.floor(params.limit ?? 200), 1), 500)}`,
    args,
  )) as any[];
  // One title map per nest, not a vault scan per row (the inbox spans nests).
  const titlesByNest = new Map<string, Map<string, string>>();
  const nestNames = new Map<string, string>();
  const out: AccessRequest[] = [];
  for (const row of rows) {
    const r = rowToRequest(row);
    let title: string;
    if (r.target_type === "node") {
      if (!titlesByNest.has(r.nest_id)) titlesByNest.set(r.nest_id, await buildTitleMap(r.nest_id));
      title = titlesByNest.get(r.nest_id)!.get(r.target_id) ?? (await titleForNode(r.nest_id, r.target_id));
    } else if (r.target_type === "folder") {
      title = prettyFolderPath(r.target_id);
    } else {
      if (!nestNames.has(r.nest_id)) nestNames.set(r.nest_id, await nestName(r.nest_id));
      title = nestNames.get(r.nest_id)!;
    }
    out.push({ ...r, title });
  }
  return out;
}

/** The nest owner, its admins and the server admins decide. */
export async function canDecideAccessRequests(nestId: string, userId: string): Promise<boolean> {
  return canManageStewards(nestId, userId);
}

/** Grant what the request asked for, through the existing share paths. */
async function grantRequested(
  request: AccessRequest,
  decidedById: string,
  decidedByEmail: string,
  baseUrl?: string,
): Promise<void> {
  const { nest_id: nestId, requester_id: userId, level } = request;
  if (request.target_type === "node" || request.target_type === "folder") {
    const target = request.target_type === "node" ? request.target_id : `nodes/${request.target_id}`;
    // Only ever an upgrade: createGrant overwrites, so a share given since must not drop.
    const held = await resolveNodeGrant(nestId, userId, target);
    if (held && permissionLevel(held) >= permissionLevel(level)) return;
    await createGrant({
      nestId,
      targetType: request.target_type === "node" ? "document" : "folder",
      target,
      userId,
      role: level,
      grantedBy: decidedByEmail,
      baseUrl,
    });
    return;
  }
  const db = getDb();
  const existing = (await db.get(
    "SELECT id, permission FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
    [nestId, userId],
  )) as { id: string; permission: NestPermission } | undefined;
  if (existing) {
    // Only ever an upgrade: approving "write" must not demote an admin who
    // asked while a cap was in force.
    if (permissionLevel(existing.permission) >= permissionLevel(level)) return;
    await assertCanGrant([{ userId, next: permissionClass(level) }]);
    await db.run("UPDATE nest_collaborators SET permission = ? WHERE id = ?", [level, existing.id]);
    return;
  }
  await addCollaborator({
    nestId,
    userId,
    permission: level,
    grantedByUserId: decidedById,
    grantedByEmail: decidedByEmail,
    baseUrl,
  });
}

/**
 * Approve or deny a pending request. Returns null when the request isn't
 * pending in this nest any more (already decided, or never existed here).
 *
 * The decision is CLAIMED first — one conditional UPDATE off 'pending' — so
 * two deciders racing can't both act: an approve and a deny can't leave the
 * access granted under a 'denied' row, and two approves don't both grant.
 * Only then does an approval grant. If the grant throws (the plan refuses the
 * seat with a 402, the nest was archived meanwhile), the claim is released
 * back to 'pending' and the error propagates, so the request is never
 * 'approved' with nothing behind it.
 *
 * The grant can't share the claim's transaction (createGrant and
 * addCollaborator run their own writes, seat checks and emails), so a process
 * dying between the two leaves an 'approved' row with no grant. That is
 * recoverable, not stuck: the next refused write still offers the request
 * (accessRequestHint never surfaces an approved row), a new ask is accepted
 * (nothing pending, no denial), and approving it grants — every grant path
 * here is an idempotent upsert / upgrade.
 */
export async function decideAccessRequest(params: {
  nestId: string;
  id: string;
  decision: "approve" | "deny";
  decidedById: string;
  decidedByEmail: string;
  note?: string;
  baseUrl?: string;
}): Promise<AccessRequest | null> {
  const pending = await getAccessRequest(params.id);
  if (!pending || pending.nest_id !== params.nestId || pending.status !== "pending") {
    return null;
  }
  const approve = params.decision === "approve";
  // Archived means read-only for everyone; granting into it would be a write.
  // Denying stays possible so the queue can still be cleared.
  if (approve && (await resolveNestAccess(params.nestId, params.decidedById)).archived) {
    throw new ValidationError("This nest is archived, so access can't be granted. Restore it first, or deny the request.");
  }
  const note = params.note?.trim() ? params.note.trim().slice(0, MAX_NOTE) : null;
  const db = getDb();
  const { changes } = await db.run(
    `UPDATE access_requests
        SET status = ?, resolved_by = ?, resolved_at = ${nowExpr(db)}, resolution_note = ?
      WHERE id = ? AND status = 'pending'`,
    [approve ? "approved" : "denied", params.decidedByEmail.toLowerCase(), note, params.id],
  );
  // Someone else decided it first: only the claim that landed acts.
  if (changes === 0) return null;
  if (approve) {
    try {
      await grantRequested(pending, params.decidedById, params.decidedByEmail, params.baseUrl);
    } catch (err) {
      try {
        await db.run(
          `UPDATE access_requests
              SET status = 'pending', resolved_by = NULL, resolved_at = NULL, resolution_note = NULL
            WHERE id = ? AND status = 'approved'`,
          [params.id],
        );
      } catch {
        // The requester asked again while this claim was out (nothing was
        // pending, so the new ask was accepted), and the one-pending index
        // refuses a second. The newer ask carries the request; drop this
        // claimed row so nothing reads 'approved' with no grant behind it.
        console.warn(
          "[access] approval claim released by deletion — a newer ask superseded it",
          params.nestId,
          params.id,
          pending.requested_by,
          params.decidedByEmail,
        );
        await db.run("DELETE FROM access_requests WHERE id = ? AND status = 'approved'", [params.id]);
      }
      throw err;
    }
  }
  const decided = (await getAccessRequest(params.id))!;
  await notifyAccessDecided(decided, params.baseUrl);
  return decided;
}

// ─── Notifications ────────────────────────────────────────────────────────
// Same fan-out as deletion requests: inbox row, nest channels, direct email.
// Best-effort — a delivery failure never fails the request or the decision.

async function targetContext(
  request: AccessRequest,
  baseUrl?: string,
): Promise<{ docTitle: string; path: string; link: string; noun: string }> {
  if (request.target_type === "node") {
    const ctx = await buildDocContext(request.nest_id, request.target_id, baseUrl);
    return { docTitle: ctx.docTitle, path: ctx.path, link: ctx.link, noun: "document" };
  }
  const name = await nestName(request.nest_id);
  return {
    docTitle: request.target_type === "folder" ? prettyFolderPath(request.target_id) : name,
    path: name,
    link: baseUrl ? `${baseUrl}/?nest=${encodeURIComponent(request.nest_id)}` : "",
    noun: request.target_type,
  };
}

const levelWord = (level: AccessLevel) => (level === "write" ? "edit" : "view");
const excerpt = (note: string | null) =>
  note ? ` — "${note.length > 140 ? `${note.slice(0, 140)}…` : note}"` : "";

async function notifyAccessRequested(request: AccessRequest, baseUrl?: string): Promise<void> {
  try {
    const ctx = await targetContext(request, baseUrl);
    const label = `${ctx.noun === "document" ? "" : `${ctx.noun} `}"${ctx.docTitle}"`;
    const noteText = request.note ? ` — "${request.note}"` : "";
    const admins = (await nestAdminEmails(request.nest_id)).filter(
      (e) => e !== request.requested_by.toLowerCase(),
    );
    await inboxInsert(
      request.nest_id,
      admins,
      "access_requested",
      request.id,
      `${request.requested_by} asked for ${levelWord(request.level)} access to ${label}${noteText}`,
    );
    // Channels get an excerpt: the full note is in the inbox and the email,
    // and a short line keeps one person's text from taking over a channel.
    // (Slack text is escaped downstream — escapeMrkdwn — so `<!channel>` in a
    // note posts as literal text.)
    const line = `${request.requested_by} asked for ${levelWord(request.level)} access to ${ctx.noun} *${ctx.docTitle}*${excerpt(request.note)}`;
    void dispatchEvent({
      kind: "access_requested",
      nestId: request.nest_id,
      subjectId: request.target_id,
      actor: request.requested_by,
      message: line,
    });
    void notifyNestEvent(request.nest_id, `:key: ${line}`, undefined, { skipEmail: true });
    if (admins.length > 0) {
      void sendEmailToRecipient(admins, {
        status: "access_requested",
        docTitle: ctx.docTitle,
        path: ctx.path,
        link: ctx.link,
        actor: request.requested_by,
        permission: request.level,
        note: request.note,
      });
    }
  } catch (err) {
    console.error("[notify] access request fan-out failed", request.nest_id, request.id, err);
  }
}

async function notifyAccessDecided(request: AccessRequest, baseUrl?: string): Promise<void> {
  try {
    const approved = request.status === "approved";
    const ctx = await targetContext(request, baseUrl);
    const label = `${ctx.noun === "document" ? "" : `${ctx.noun} `}"${ctx.docTitle}"`;
    const by = request.resolved_by ?? "an admin";
    const noteText = request.resolution_note ? ` — "${request.resolution_note}"` : "";
    // The ask is no longer actionable for any admin who got it.
    await markNotificationsReadBySubject(request.id, "access_requested");
    if (request.requested_by.toLowerCase() !== by.toLowerCase()) {
      await inboxInsert(
        request.nest_id,
        [request.requested_by],
        approved ? "access_approved" : "access_denied",
        request.id,
        approved
          ? `${by} approved your request to ${levelWord(request.level)} ${label} — you can make your change now`
          : `${by} denied your request to ${levelWord(request.level)} ${label}${noteText}`,
      );
      void sendEmailToRecipient(request.requested_by, {
        status: approved ? "access_approved" : "access_denied",
        docTitle: ctx.docTitle,
        path: ctx.path,
        link: ctx.link,
        actor: by,
        permission: request.level,
        note: request.resolution_note,
      });
    }
    void dispatchEvent({
      kind: approved ? "access_approved" : "access_denied",
      nestId: request.nest_id,
      subjectId: request.target_id,
      actor: by,
      message: `${by} ${approved ? "approved" : "denied"} ${request.requested_by}'s request to ${levelWord(request.level)} ${ctx.noun} *${ctx.docTitle}*${excerpt(request.resolution_note)}`,
    });
  } catch (err) {
    console.error("[notify] access decision fan-out failed", request.nest_id, request.id, err);
  }
}

// ─── Which target a refused write was aimed at ────────────────────────────

/** POST/DELETE suffixes on a node route that act on the node itself. */
const NODE_ACTION_SUFFIXES = new Set(["revert", "move", "discard", "watchers"]);

/**
 * The thing a refused write was aimed at, from the request path alone (the
 * nest middleware's `parts`: [nestId, resource, …]). A document route names
 * the document; creating, uploading, or any other nest-level write names the
 * nest — creation needs nest write, so a folder share wouldn't help there.
 * Never reads the body or the database: the 403 must not cost a lookup the
 * request didn't need, nor reveal anything the path didn't already say.
 */
export function writeTargetForPath(
  nestId: string,
  parts: string[],
  method: string,
): AccessTarget {
  if (parts[1] === "nodes" && parts.length >= 3 && !(parts.length === 3 && parts[2] === "pdf")) {
    let tail = parts.slice(2);
    // A node id is at least "nodes/<slug>", so only a third segment can be an
    // action suffix (PATCH never carries one).
    if (method !== "PATCH" && tail.length > 2 && NODE_ACTION_SUFFIXES.has(tail[tail.length - 1])) {
      tail = tail.slice(0, -1);
    }
    let id = tail.join("/");
    try {
      id = decodeURIComponent(id);
    } catch {
      /* malformed escape — echo as sent */
    }
    return { type: "node", id };
  }
  return { type: "nest", id: nestId };
}
