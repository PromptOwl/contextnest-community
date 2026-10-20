/**
 * Named systems (CU-wdqcq0538g): machine identities such as "GitHub sync"
 * that read or write the nests an admin grants them. One service layer behind
 * both the REST routes (auth/system-routes.ts) and the MCP admin tool
 * `context_systems` (mcp/tools.ts), so the two surfaces can't drift on who may
 * do what.
 *
 * ── Mechanism: built on the existing SERVICE identity ────────────────────
 * A system is a `users` row with is_service = 1 — the same kind of no-login
 * identity a headless access key (CU-wdqcq0314u) or a metacognition persona
 * gets — plus a `system_accounts` row (what tells it apart from those) and
 * exactly one `api_keys` row (cnst_sys_…). Reusing is_service means every
 * existing "people only" rule applies for free: no sessions (createSession),
 * no OIDC / PromptOwl ticket / SSO sign-in, not a seat, not in teammates or
 * people search, not counted in /stats or telemetry.
 *
 * Unlike a headless reader it gets NO headless_readers row and is not
 * clamped by the headless allowlists (isHeadlessIdentity excludes it). It
 * reaches a nest only through an ordinary nest_collaborators row (read =
 * viewer, write = editor), so:
 *  - Governance: stewardship, review and approval apply exactly as they do
 *    to a human editor.
 *  - Attribution: writes are authored by the system's own identity (its
 *    users.email, an unroutable *.contextnest.invalid address), never by
 *    whoever created it.
 *  - Ownership: the key belongs to the system, not its creator, so removing
 *    the creator (from a nest, or from the server) touches nothing.
 *
 * Its key is fenced in the nest-scope guard (systemKeyVerdict): never
 * /auth/*, /systems, /admin, nest create/edit, or a nest's people/settings/
 * keys/automation routes (the nests-app gate).
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import {
  insertApiKey,
  getKeyPrefix,
  generateApiKey,
  hashApiKey,
  SYSTEM_KEY_PREFIX,
} from "./keys.js";
import { resolveNestPermission, permissionLevel } from "../shared/access.js";
import { trackEvent } from "../telemetry/tracker.js";

/** Placeholder password hash. Not bcrypt and not the legacy "<salt>:<sha256>"
 *  shape, so verifyPassword can never accept anything (same idea as the
 *  headless access-key identities' "!"). */
export const NO_PASSWORD = "!system-no-login";
/** Reserved TLD (RFC 2606) for principal identities: unroutable, so a
 *  notification addressed to a system goes nowhere, and no IdP can assert it. */
const PRINCIPAL_EMAIL_DOMAIN = "contextnest.invalid";

export const MAX_SYSTEM_NAME_LENGTH = 60;

export type ServiceResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

const fail = (
  status: 400 | 403 | 404 | 409,
  error: string,
): { ok: false; status: 400 | 403 | 404 | 409; error: string } => ({
  ok: false,
  status,
  error,
});

/** Is this user a named system? */
export async function isSystemUser(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const row = await getDb().get("SELECT 1 AS hit FROM system_accounts WHERE user_id = ?", [userId]);
  return !!row;
}

/** Is this user a person (not any kind of service identity)? */
async function isPerson(userId: string): Promise<boolean> {
  const row = (await getDb().get("SELECT is_service FROM users WHERE id = ?", [userId])) as
    | { is_service: number | null }
    | undefined;
  return !!row && !row.is_service;
}

/** Nest owner or admin (folds in server admins, via resolveNestPermission). */
export async function isNestAdmin(nestId: string, userId: string): Promise<boolean> {
  return (
    permissionLevel(await resolveNestPermission(nestId, userId)) >=
    permissionLevel("admin")
  );
}

/**
 * The actor managing a system (or a nest's headless keys over MCP) must be a
 * person acting with a full credential. A read-only key, a system key or a
 * headless access key can never mint or manage keys — so a leaked key can't
 * be laundered into a fresh or broader one.
 */
export async function checkActor(
  actorId: string,
  capability: string | undefined,
): Promise<{ ok: false; status: 403; error: string } | null> {
  if (capability && capability !== "write") {
    return {
      ok: false,
      status: 403,
      error: "A read-only key cannot create or manage systems or access keys.",
    };
  }
  if (!(await isPerson(actorId))) {
    return {
      ok: false,
      status: 403,
      error: "Only a person can create or manage systems and access keys.",
    };
  }
  return null;
}

function cleanName(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return undefined;
  if (t.length > MAX_SYSTEM_NAME_LENGTH) return null;
  return t;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "system"
  );
}

async function actorEmail(actorId: string): Promise<string | null> {
  const row = (await getDb().get("SELECT email FROM users WHERE id = ?", [
    actorId,
  ])) as { email?: string } | undefined;
  return row?.email ?? null;
}

async function insertSystem(
  tx: { run(sql: string, params?: unknown[]): Promise<unknown> },
  opts: {
    id: string;
    name: string;
    email: string;
    capability: "read" | "write";
    createdBy: string;
    createdByEmail: string | null;
  },
) {
  await tx.run(
    "INSERT INTO users (id, email, name, password_hash, is_service) VALUES (?, ?, ?, ?, 1)",
    [opts.id, opts.email, opts.name, NO_PASSWORD],
  );
  await tx.run(
    `INSERT INTO system_accounts (user_id, name, capability, created_by, created_by_email)
     VALUES (?, ?, ?, ?, ?)`,
    [opts.id, opts.name, opts.capability, opts.createdBy, opts.createdByEmail],
  );
}

/** Delete a system and everything hanging off it. */
async function deletePrincipal(userId: string): Promise<void> {
  const db = getDb();
  const user = (await db.get("SELECT email FROM users WHERE id = ?", [userId])) as
    | { email: string }
    | undefined;
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM api_keys WHERE user_id = ?", [userId]);
    await tx.run("DELETE FROM nest_collaborators WHERE user_id = ?", [userId]);
    await tx.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    if (user?.email) {
      await tx.run(
        "DELETE FROM stewards WHERE user_id = ? OR lower(user_email) = lower(?)",
        [userId, user.email],
      );
    }
    await tx.run("DELETE FROM system_accounts WHERE user_id = ?", [userId]);
    await tx.run("DELETE FROM users WHERE id = ? AND is_service = 1", [userId]);
  });
}

/** Replace the system's key with a fresh one (old secret dies at once). */
async function rotatePrincipalKey(
  userId: string,
  opts: { nestId: string | null; label: string; capability: string; prefix: string },
): Promise<{ apiKey: string; keyPrefix: string }> {
  const db = getDb();
  const apiKey = generateApiKey(opts.prefix);
  const keyPrefix = getKeyPrefix(apiKey);
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM api_keys WHERE user_id = ?", [userId]);
    await tx.run(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, nest_id, label, capability, origin) VALUES (?, ?, ?, ?, ?, ?, ?, 'service')",
      [uuid(), userId, hashApiKey(apiKey), keyPrefix, opts.nestId, opts.label, opts.capability],
    );
  });
  return { apiKey, keyPrefix };
}

// ─── Named systems ────────────────────────────────────────────────────────

export interface SystemInfo {
  id: string;
  name: string;
  email: string;
  capability: "read" | "write";
  key_prefix: string | null;
  /** The granted nests the CALLER administers (others are only counted, so a
   *  listing never reveals the names of nests the caller can't manage). */
  nests: Array<{ id: string; name: string; permission: string }>;
  other_nest_count: number;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface SystemRow {
  id: string;
  name: string;
  email: string;
  capability: "read" | "write";
  key_prefix: string | null;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
  last_used_at: string | null;
}

const SYSTEM_SELECT = `SELECT sa.user_id AS id, sa.name, u.email, sa.capability,
            sa.created_by, sa.created_by_email, sa.created_at,
            k.key_prefix, k.last_used_at
       FROM system_accounts sa
       JOIN users u ON u.id = sa.user_id
       LEFT JOIN api_keys k ON k.user_id = sa.user_id
      WHERE 1 = 1`;

async function systemNests(
  systemId: string,
): Promise<Array<{ id: string; name: string; permission: string }>> {
  return (await getDb().all(
    `SELECT n.id, n.name, nc.permission FROM nest_collaborators nc
       JOIN nests n ON n.id = nc.nest_id
      WHERE nc.user_id = ? ORDER BY n.name, n.id`,
    [systemId],
  )) as Array<{ id: string; name: string; permission: string }>;
}

async function getSystemRow(systemId: string): Promise<SystemRow | null> {
  return ((await getDb().get(`${SYSTEM_SELECT} AND sa.user_id = ?`, [systemId])) as
    | SystemRow
    | undefined) ?? null;
}

async function describeSystem(
  row: SystemRow,
  actorId: string,
  adminCache: Map<string, boolean>,
): Promise<SystemInfo> {
  const all = await systemNests(row.id);
  const mine: SystemInfo["nests"] = [];
  for (const n of all) {
    let ok = adminCache.get(n.id);
    if (ok === undefined) {
      ok = await isNestAdmin(n.id, actorId);
      adminCache.set(n.id, ok);
    }
    if (ok) mine.push(n);
  }
  return { ...row, nests: mine, other_nest_count: all.length - mine.length };
}

/** Admin of at least one nest the system is granted on — the bar to SEE it. */
async function canSeeSystem(systemId: string, actorId: string): Promise<boolean> {
  for (const n of await systemNests(systemId)) {
    if (await isNestAdmin(n.id, actorId)) return true;
  }
  return false;
}

/** Admin of EVERY granted nest — the bar to rotate or revoke the whole system,
 *  since both cut off nests other admins may own. A system left with no nests
 *  (every nest it worked in was deleted) can only be cleaned up by its creator. */
async function canManageWholeSystem(
  systemId: string,
  actorId: string,
  createdBy: string | null,
): Promise<boolean> {
  const nests = await systemNests(systemId);
  if (nests.length === 0) return createdBy === actorId;
  for (const n of nests) {
    if (!(await isNestAdmin(n.id, actorId))) return false;
  }
  return true;
}

export async function listSystems(opts: {
  actorId: string;
  nestId?: string;
  capability?: string;
}): Promise<ServiceResult<{ systems: SystemInfo[] }>> {
  const bad = await checkActor(opts.actorId, opts.capability);
  if (bad) return bad;
  const db = getDb();
  let rows: SystemRow[];
  if (opts.nestId) {
    if (!(await isNestAdmin(opts.nestId, opts.actorId))) {
      return fail(403, "Only a nest owner or admin can see this nest's systems.");
    }
    rows = (await db.all(
      `${SYSTEM_SELECT}
         AND EXISTS (SELECT 1 FROM nest_collaborators nc
                      WHERE nc.user_id = sa.user_id AND nc.nest_id = ?)
       ORDER BY sa.created_at ASC, sa.user_id ASC`,
      [opts.nestId],
    )) as SystemRow[];
  } else {
    rows = (await db.all(
      `${SYSTEM_SELECT} ORDER BY sa.created_at ASC, sa.user_id ASC`,
    )) as SystemRow[];
  }
  const cache = new Map<string, boolean>();
  const out: SystemInfo[] = [];
  for (const r of rows) {
    const info = await describeSystem(r, opts.actorId, cache);
    // Systems visible to the caller = granted on at least one nest they admin.
    if (info.nests.length > 0) out.push(info);
  }
  return { ok: true, systems: out };
}

export async function createSystem(opts: {
  actorId: string;
  name: unknown;
  capability: unknown;
  nestIds: unknown;
  actorCapability?: string;
}): Promise<ServiceResult<{ system: SystemInfo; api_key: string }>> {
  const bad = await checkActor(opts.actorId, opts.actorCapability);
  if (bad) return bad;
  const name = cleanName(opts.name);
  if (name === null) {
    return fail(400, `name must be a string of at most ${MAX_SYSTEM_NAME_LENGTH} characters.`);
  }
  if (!name) return fail(400, 'name is required (e.g. "GitHub sync").');
  const capability =
    opts.capability === undefined || opts.capability === null || opts.capability === ""
      ? "read"
      : opts.capability;
  if (capability !== "read" && capability !== "write") {
    return fail(400, 'capability must be "read" or "write".');
  }
  if (
    !Array.isArray(opts.nestIds) ||
    opts.nestIds.length === 0 ||
    !opts.nestIds.every((n) => typeof n === "string" && n.trim())
  ) {
    return fail(400, "nest_ids must be a non-empty list of nest ids.");
  }
  const nestIds = [...new Set((opts.nestIds as string[]).map((n) => n.trim()))];
  for (const n of nestIds) {
    // Unknown and not-administered answer the same 403 (no existence oracle).
    if (!(await isNestAdmin(n, opts.actorId))) {
      return fail(403, `You must be an owner or admin of every nest you grant (${n}).`);
    }
  }

  const db = getDb();
  const id = uuid();
  const email = `${slugify(name)}-${id.slice(0, 8)}@system.${PRINCIPAL_EMAIL_DOMAIN}`;
  const createdByEmail = await actorEmail(opts.actorId);
  const permission = capability; // read → viewer, write → editor
  let minted!: { apiKey: string; keyPrefix: string };
  await db.transaction(async (tx) => {
    await insertSystem(tx, {
      id,
      name,
      email,
      capability,
      createdBy: opts.actorId,
      createdByEmail,
    });
    for (const n of nestIds) {
      await tx.run(
        "INSERT INTO nest_collaborators (id, nest_id, user_id, permission, granted_by) VALUES (?, ?, ?, ?, ?)",
        [uuid(), n, id, permission, opts.actorId],
      );
    }
    minted = await insertApiKey(tx, {
      id: uuid(),
      userId: id,
      // Spans several nests → unscoped; the collaborator rows are the fence.
      nestId: null,
      label: name,
      capability,
      origin: "service",
      prefix: SYSTEM_KEY_PREFIX,
    });
  });
  trackEvent("system.create", { userId: opts.actorId, systemId: id, capability });
  const system = await describeSystem((await getSystemRow(id))!, opts.actorId, new Map());
  return { ok: true, system, api_key: minted.apiKey };
}

export async function rotateSystem(opts: {
  actorId: string;
  systemId: string;
  actorCapability?: string;
}): Promise<ServiceResult<{ system: SystemInfo; api_key: string }>> {
  const bad = await checkActor(opts.actorId, opts.actorCapability);
  if (bad) return bad;
  const row = await getSystemRow(opts.systemId);
  if (!row || !(await canSeeSystem(row.id, opts.actorId) || row.created_by === opts.actorId)) {
    return fail(404, "System not found");
  }
  if (!(await canManageWholeSystem(row.id, opts.actorId, row.created_by))) {
    return fail(
      403,
      "Rotating a system cuts off every nest it works in — you must be an admin of all of them. Remove your nest from it instead.",
    );
  }
  const { apiKey } = await rotatePrincipalKey(row.id, {
    nestId: null,
    label: row.name,
    capability: row.capability,
    prefix: SYSTEM_KEY_PREFIX,
  });
  trackEvent("system.rotate", { userId: opts.actorId, systemId: row.id });
  const system = await describeSystem((await getSystemRow(row.id))!, opts.actorId, new Map());
  return { ok: true, system, api_key: apiKey };
}

export async function revokeSystem(opts: {
  actorId: string;
  systemId: string;
  actorCapability?: string;
}): Promise<ServiceResult<{ deleted: true }>> {
  const bad = await checkActor(opts.actorId, opts.actorCapability);
  if (bad) return bad;
  const row = await getSystemRow(opts.systemId);
  if (!row || !(await canSeeSystem(row.id, opts.actorId) || row.created_by === opts.actorId)) {
    return fail(404, "System not found");
  }
  if (!(await canManageWholeSystem(row.id, opts.actorId, row.created_by))) {
    return fail(
      403,
      "Revoking a system cuts off every nest it works in — you must be an admin of all of them. Remove your nest from it instead.",
    );
  }
  await deletePrincipal(row.id);
  trackEvent("system.revoke", { userId: opts.actorId, systemId: row.id });
  return { ok: true, deleted: true };
}

export async function addSystemNest(opts: {
  actorId: string;
  systemId: string;
  nestId: unknown;
  actorCapability?: string;
}): Promise<ServiceResult<{ system: SystemInfo }>> {
  const bad = await checkActor(opts.actorId, opts.actorCapability);
  if (bad) return bad;
  const nestId = typeof opts.nestId === "string" ? opts.nestId.trim() : "";
  if (!nestId) return fail(400, "nest_id is required.");
  const row = await getSystemRow(opts.systemId);
  // You must already manage the system (admin of one of its nests) — otherwise
  // anyone could adopt a system they merely know the id of.
  if (!row || !(await canSeeSystem(row.id, opts.actorId))) {
    return fail(404, "System not found");
  }
  if (!(await isNestAdmin(nestId, opts.actorId))) {
    return fail(403, "You must be an owner or admin of the nest you add.");
  }
  const db = getDb();
  const existing = await db.get(
    "SELECT id FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
    [nestId, row.id],
  );
  if (existing) return fail(409, "This system already works in that nest.");
  await db.run(
    "INSERT INTO nest_collaborators (id, nest_id, user_id, permission, granted_by) VALUES (?, ?, ?, ?, ?)",
    [uuid(), nestId, row.id, row.capability, opts.actorId],
  );
  trackEvent("system.add_nest", { userId: opts.actorId, systemId: row.id, nestId });
  const system = await describeSystem(row, opts.actorId, new Map());
  return { ok: true, system };
}

export async function removeSystemNest(opts: {
  actorId: string;
  systemId: string;
  nestId: string;
  actorCapability?: string;
}): Promise<ServiceResult<{ removed: true; system_deleted: boolean }>> {
  const bad = await checkActor(opts.actorId, opts.actorCapability);
  if (bad) return bad;
  const row = await getSystemRow(opts.systemId);
  if (!row) return fail(404, "System not found");
  if (!(await isNestAdmin(opts.nestId, opts.actorId))) {
    return fail(404, "System not found");
  }
  const db = getDb();
  const res = await db.run(
    "DELETE FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
    [opts.nestId, row.id],
  );
  if (res.changes === 0) return fail(404, "This system doesn't work in that nest.");
  // A system with no nests can do nothing and nobody could manage it — retire it.
  const left = await systemNests(row.id);
  if (left.length === 0) await deletePrincipal(row.id);
  trackEvent("system.remove_nest", { userId: opts.actorId, systemId: row.id, nestId: opts.nestId });
  return { ok: true, removed: true, system_deleted: left.length === 0 };
}
