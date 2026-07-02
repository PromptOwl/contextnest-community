/**
 * Stewardship Service — SQLite implementation of StewardshipAdapter.
 *
 * Ported from PromptOwl's contextStewardship.ts actions + ContextSteward model.
 * Resolution hierarchy: document(1) > tag(2) > nest(3).
 */

import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { isSuperAdmin } from "./access-service.js";
import { ConflictError, ValidationError } from "../shared/errors.js";
import { buildTitleMap } from "./title-resolver.js";
import { resolveNestPermission } from "../shared/access.js";
import { nestAllowsSelfApprove } from "../nests/service.js";
import { config } from "../config.js";
import {
  type EffectiveRole,
  collabPermToRole,
  canViewWith,
  canEditWith,
  primaryRole,
} from "./roles.js";
import type {
  Steward,
  ResolvedSteward,
  StewardsConfig,
  StewardEntry,
  StewardshipScope,
  StewardRole,
} from "./types.js";

// ─── CRUD ───────────────────────────────────────────────────────────────

export async function assignSteward(data: Omit<Steward, "id">): Promise<Steward> {
  const db = getDb();
  const id = uuid();

  await db.run(
    `INSERT INTO stewards
     (id, nest_id, scope, node_pattern, tag_name, user_email, user_id, role, assigned_by, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.nestId,
      data.scope,
      data.nodePattern || null,
      data.tagName || null,
      data.userEmail,
      data.userId || null,
      data.role,
      data.assignedBy,
      data.isActive ? 1 : 0,
    ],
  );

  return { ...data, id };
}

export async function removeSteward(id: string): Promise<void> {
  const db = getDb();
  // Steward and collaborator grants are independent — removing a steward
  // only drops the steward row. Any nest_collaborators access the user has
  // is managed separately via the Share UI and is left untouched.
  await db.run("DELETE FROM stewards WHERE id = ?", [id]);
}

const VALID_STEWARD_ROLES: StewardRole[] = ["editor", "reviewer", "viewer"];

export interface StewardUpdate {
  role?: StewardRole;
  /** Provide to re-scope the steward. Omit to leave scope/target untouched. */
  scope?: StewardshipScope;
  documentId?: string;
  tagName?: string;
}

/**
 * Update an existing steward's role and/or scope in place, so an admin doesn't
 * have to remove-and-re-add to adjust it. Role moves alone when only `role` is
 * given; passing `scope` re-targets the row (and clears the unused target
 * columns). Re-scoping is guarded against duplicates: another active row for the
 * same (nest, scope, target, user) is rejected with a ConflictError.
 */
export async function updateSteward(id: string, update: StewardUpdate): Promise<Steward> {
  const db = getDb();
  const current = await db.get(
    "SELECT * FROM stewards WHERE id = ? AND is_active = 1",
    [id],
  ) as any;
  if (!current) {
    throw new ValidationError("Steward not found");
  }

  const role: StewardRole = update.role ?? current.role;
  if (!VALID_STEWARD_ROLES.includes(role)) {
    throw new ValidationError(
      `Invalid role "${role}" — must be editor, reviewer, or viewer.`,
    );
  }

  // Default to the current scope/target; only recompute when re-scoping.
  let scope: StewardshipScope = current.scope;
  let nodePattern: string | null = current.node_pattern ?? null;
  let tagName: string | null = current.tag_name ?? null;

  if (update.scope) {
    scope = update.scope;
    nodePattern = null;
    tagName = null;
    switch (scope) {
      case "document":
        if (!update.documentId)
          throw new ValidationError("documentId required for document scope");
        nodePattern = update.documentId;
        break;
      case "tag":
        if (!update.tagName)
          throw new ValidationError("tagName required for tag scope");
        tagName = update.tagName.trim().replace(/^#+/, "").toLowerCase();
        break;
      case "nest":
        break;
    }

    // Block collision: same user can't hold two rows for the same scope+target.
    const dup = await db.get(
      `SELECT role FROM stewards
         WHERE nest_id = ? AND is_active = 1 AND id != ? AND scope = ?
           AND user_email = ?
           AND COALESCE(node_pattern, '') = COALESCE(?, '')
           AND COALESCE(tag_name, '') = COALESCE(?, '')`,
      [current.nest_id, id, scope, current.user_email, nodePattern, tagName],
    ) as
      | { role: string }
      | undefined;
    if (dup) {
      const scopeLabel =
        scope === "document"
          ? `document "${nodePattern}"`
          : scope === "tag"
            ? `tag "#${tagName}"`
            : "this nest";
      throw new ConflictError(
        `"${current.user_email}" is already a steward of ${scopeLabel} with the "${dup.role}" role.`,
      );
    }
  }

  await db.run(
    "UPDATE stewards SET role = ?, scope = ?, node_pattern = ?, tag_name = ? WHERE id = ?",
    [role, scope, nodePattern, tagName, id],
  );

  const row = await db.get("SELECT * FROM stewards WHERE id = ?", [id]) as any;
  return rowToSteward(row);
}

/** Back-compat thin wrapper — role-only update. */
export async function updateStewardRole(id: string, role: StewardRole): Promise<Steward> {
  return updateSteward(id, { role });
}

export async function getSteward(id: string): Promise<Steward | null> {
  const db = getDb();
  const row = await db.get("SELECT * FROM stewards WHERE id = ?", [id]) as any;
  return row ? rowToSteward(row) : null;
}

export async function getStewardsForNest(nestId: string): Promise<Steward[]> {
  const db = getDb();
  const rows = await db.all(
    "SELECT * FROM stewards WHERE nest_id = ? AND is_active = 1",
    [nestId],
  ) as any[];
  return enrichWithTitles(nestId, rows.map(rowToSteward));
}

export async function getStewardsForScope(params: {
  nestId: string;
  scope?: StewardshipScope;
  scopeTarget?: string;
}): Promise<Steward[]> {
  const db = getDb();
  let sql = "SELECT * FROM stewards WHERE nest_id = ? AND is_active = 1";
  const args: any[] = [params.nestId];

  if (params.scope) {
    sql += " AND scope = ?";
    args.push(params.scope);
  }
  if (params.scopeTarget) {
    sql += " AND (node_pattern = ? OR tag_name = ?)";
    args.push(params.scopeTarget, params.scopeTarget);
  }

  return (await db.all(sql, args) as any[]).map(rowToSteward);
}

/**
 * List stewards with filters. Mirrors PromptOwl StewardsListPage filters.
 */
export async function listStewards(params: {
  nestId: string;
  scope?: StewardshipScope;
  search?: string;
}): Promise<Steward[]> {
  const db = getDb();
  let sql = "SELECT * FROM stewards WHERE nest_id = ? AND is_active = 1";
  const args: any[] = [params.nestId];

  if (params.scope) {
    sql += " AND scope = ?";
    args.push(params.scope);
  }
  if (params.search) {
    sql += " AND (user_email LIKE ? OR tag_name LIKE ? OR node_pattern LIKE ?)";
    const like = `%${params.search.toLowerCase()}%`;
    args.push(like, like, like);
  }
  sql += " ORDER BY scope, COALESCE(node_pattern, tag_name, ''), user_email";
  const stewards = (await db.all(sql, args) as any[]).map(rowToSteward);

  return enrichWithTitles(params.nestId, stewards);
}

// Resolve nodeTitle from on-disk frontmatter for document-scoped rows.
// Title is not duplicated into the DB — frontmatter is source of truth —
// so we look it up here. Skips the storage scan when no doc-scoped row
// exists in the result set.
async function enrichWithTitles(
  nestId: string,
  stewards: Steward[],
): Promise<Steward[]> {
  if (!stewards.some((s) => s.scope === "document")) return stewards;
  const titleByNodeId = await buildTitleMap(nestId);
  for (const s of stewards) {
    if (s.scope === "document" && s.nodePattern) {
      s.nodeTitle = titleByNodeId.get(s.nodePattern);
    }
  }
  return stewards;
}

/**
 * Create a steward record for a (scope, target) with N users.
 * Inserts one row per user — partial unique indexes enforce idempotency.
 * Returns the inserted rows (existing rows for a duplicate email are skipped).
 *
 * Stewardship and collaboration are independent grants: a steward row grants
 * scoped document/context rights, a collaborator row grants nest-wide access.
 * We do NOT mirror a collaborator row here — nest visibility for stewards
 * comes from resolveNestPermission/listSharedNests recognizing steward rows,
 * and edit/approve rights come from resolveUserRoles merging both sources.
 */
export async function createStewardRecord(params: {
  nestId: string;
  scope: StewardshipScope;
  documentId?: string;
  tagName?: string;
  users: Array<{
    email: string;
    role?: StewardRole;
  }>;
  assignedBy: string;
}): Promise<Steward[]> {
  if (params.users.length === 0) {
    throw new Error("At least one user is required");
  }

  // Pick the right target column for the scope.
  let nodePattern: string | undefined;
  let tagName: string | undefined;
  switch (params.scope) {
    case "document":
      if (!params.documentId) throw new Error("documentId required for document scope");
      nodePattern = params.documentId;
      break;
    case "tag":
      if (!params.tagName) throw new Error("tagName required for tag scope");
      tagName = params.tagName.trim().replace(/^#+/, "").toLowerCase();
      break;
    case "nest":
      break;
  }

  const db = getDb();
  const results: Steward[] = [];

  // The nest owner is an implicit admin with full edit/approve rights, so they
  // never need an explicit steward grant — and giving the owner a reviewer row
  // makes their effective role ambiguous (owner Edit vs reviewer approve/reject
  // on the same doc). Likewise, whoever manages the roster can't grant a steward
  // role to themselves. Block both so the roster only holds delegated users.
  const actor = (params.assignedBy || "").trim().toLowerCase();
  const ownerEmail = (await getNestOwnerEmail(params.nestId) || "").toLowerCase();

  for (const user of params.users) {
    const email = user.email.trim().toLowerCase();
    if (!email) continue;

    if (email === actor) {
      throw new ValidationError(
        "You already manage this nest, so you can't add yourself as a steward.",
      );
    }
    if (ownerEmail && email === ownerEmail) {
      throw new ValidationError(
        "The nest owner already has full access and doesn't need a steward role.",
      );
    }

    // Check for existing active row (idempotent).
    const existing = await db.get(
      `SELECT * FROM stewards
         WHERE nest_id = ? AND is_active = 1 AND scope = ? AND user_email = ?
           AND COALESCE(node_pattern, '') = COALESCE(?, '')
           AND COALESCE(tag_name, '') = COALESCE(?, '')`,
      [
        params.nestId,
        params.scope,
        email,
        nodePattern ?? null,
        tagName ?? null,
      ],
    ) as any;

    if (existing) {
      const scopeLabel =
        params.scope === "document"
          ? `document "${nodePattern}"`
          : params.scope === "tag"
            ? `tag "#${tagName}"`
            : "this nest";
      throw new ConflictError(
        `"${email}" is already a steward of ${scopeLabel} with the "${existing.role}" role. Remove the existing assignment first to change the role.`,
      );
    }

    const userRow = await db.get(
      "SELECT id FROM users WHERE email = ?",
      [email],
    ) as { id: string } | undefined;

    const created = await assignSteward({
      nestId: params.nestId,
      scope: params.scope,
      nodePattern,
      tagName,
      userEmail: email,
      userId: userRow?.id,
      role: user.role ?? "reviewer",
      assignedBy: params.assignedBy,
      assignedAt: new Date().toISOString(),
      isActive: true,
    });
    results.push(created);
  }

  // If adding any stewards, ensure governed mode is on.
  await db.run(
    "UPDATE nests SET stewardship_enabled = 1 WHERE id = ? AND stewardship_enabled = 0",
    [params.nestId],
  );

  return results;
}

// ─── STEWARD RESOLUTION ─────────────────────────────────────────────────
// Ported from PromptOwl's resolveStewardsForDocument aggregation pipeline.
// Priority: document(1) > tag(2) > nest(3).
//
// Executed as a single SQL UNION ALL so large vaults don't pay an in-memory scan.
// Tags are read from node_tag_index (kept in sync by tag-index-service).
// Folder scope supports both exact path-prefix ('team/docs') and legacy globs.
// Document scope is exact match only in the SQL path; globs fall back to JS scan.

export interface ResolveResult {
  stewards: ResolvedSteward[];
  fallbackToOwner: boolean;
  ownerEmail?: string;
}

export async function resolveStewardsForNode(
  nestId: string,
  nodeId: string,
): Promise<ResolvedSteward[]> {
  return (await resolve(nestId, nodeId)).stewards;
}

export async function resolveStewardsWithFallback(
  nestId: string,
  nodeId: string,
): Promise<ResolveResult> {
  return resolve(nestId, nodeId);
}

async function resolve(nestId: string, nodeId: string): Promise<ResolveResult> {
  const db = getDb();

  type Row = {
    id: string;
    nest_id: string;
    scope: string;
    node_pattern: string | null;
    tag_name: string | null;
    user_email: string;
    user_id: string | null;
    role: string;
    assigned_by: string;
    assigned_at: string;
    is_active: number;
    priority: number;
    match_source: string;
  };

  // Document: exact match on node_pattern (no globs — keep SQL simple).
  // Tag: JOIN on node_tag_index for fast tag lookup.
  // Nest: unconditional.
  const rows = await db.all(
    `
      SELECT s.*, 1 AS priority, ('document: ' || s.node_pattern) AS match_source
        FROM stewards s
        WHERE s.nest_id = ? AND s.is_active = 1 AND s.scope = 'document'
          AND s.node_pattern = ?
      UNION ALL
      SELECT s.*, 2 AS priority, ('tag: ' || s.tag_name) AS match_source
        FROM stewards s
        JOIN node_tag_index nt
          ON nt.nest_id = s.nest_id
         AND nt.tag_name = s.tag_name
        WHERE s.nest_id = ? AND s.is_active = 1 AND s.scope = 'tag'
          AND nt.node_id = ?
      UNION ALL
      SELECT s.*, 3 AS priority, 'nest-level steward' AS match_source
        FROM stewards s
        WHERE s.nest_id = ? AND s.is_active = 1 AND s.scope = 'nest'
      ORDER BY priority ASC, user_email ASC
      `,
    [
      nestId, nodeId,                  // document branch
      nestId, nodeId,                  // tag branch
      nestId,                          // nest branch
    ],
  ) as Row[];

  const resolved: ResolvedSteward[] = rows.map((row) => ({
    steward: rowToSteward(row),
    priority: row.priority,
    source: row.match_source,
  }));

  if (resolved.length > 0) {
    return { stewards: resolved, fallbackToOwner: false };
  }

  // Fallback: nest owner is the implicit steward when nothing resolves.
  const owner = await db.get(
    `SELECT u.email FROM nests n
       JOIN users u ON u.id = n.user_id
       WHERE n.id = ?`,
    [nestId],
  ) as { email: string } | undefined;

  return {
    stewards: [],
    fallbackToOwner: true,
    ownerEmail: owner?.email,
  };
}

// ─── UNIFIED ROLE RESOLUTION ────────────────────────────────────────────
// Merge collaborator perms (nest_collaborators) + steward rows into one
// effective-role array. See roles.ts for the vocabulary and capability map.

async function userIdForEmail(email: string): Promise<string | undefined> {
  const db = getDb();
  const row = await db.get(
    "SELECT id FROM users WHERE LOWER(email) = LOWER(?)",
    [email],
  ) as { id: string } | undefined;
  return row?.id;
}

/** Distinct active steward roles a user holds anywhere on the nest. */
export async function getStewardRolesForUser(
  nestId: string,
  userEmail: string,
): Promise<StewardRole[]> {
  const db = getDb();
  const rows = await db.all(
    "SELECT DISTINCT role FROM stewards WHERE nest_id = ? AND is_active = 1 AND LOWER(user_email) = LOWER(?)",
    [nestId, userEmail],
  ) as { role: StewardRole }[];
  return rows.map((r) => r.role);
}

/**
 * The caller's own active steward rows (with scope), not the whole roster.
 * The full roster is admin-only, but a reviewer/editor still needs their own
 * scoped rows to drive per-node affordances — this exposes just those.
 */
export async function getStewardsForUser(
  nestId: string,
  userEmail: string,
): Promise<Steward[]> {
  const db = getDb();
  const rows = await db.all(
    "SELECT * FROM stewards WHERE nest_id = ? AND is_active = 1 AND LOWER(user_email) = LOWER(?)",
    [nestId, userEmail],
  ) as any[];
  return rows.map(rowToSteward);
}

/** A user's nest_collaborators.permission, or null if not a collaborator. */
export async function getCollaboratorRole(
  nestId: string,
  userEmail: string,
): Promise<string | null> {
  const userId = await userIdForEmail(userEmail);
  if (!userId) return null;
  const db = getDb();
  const row = await db.get(
    "SELECT permission FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
    [nestId, userId],
  ) as { permission: string } | undefined;
  return row?.permission ?? null;
}

/**
 * Effective roles for a user on a nest, merged from collaborator access and
 * steward assignments. When `nodeId` is given, steward rows are resolved for
 * that node (document > tag > nest); otherwise every active steward row on
 * the nest counts (used for list display and coarse nest-wide gating).
 */
export async function resolveUserRoles(
  nestId: string,
  userEmail: string,
  opts?: { nodeId?: string },
): Promise<EffectiveRole[]> {
  const roles = new Set<EffectiveRole>();

  if (isSuperAdmin(userEmail)) roles.add("admin");

  const owner = await getNestOwnerEmail(nestId);
  if (owner && owner.toLowerCase() === userEmail.toLowerCase()) {
    roles.add("owner");
  }

  // Collaborator access (nest-wide). resolveNestPermission also yields the
  // public-visibility 'read' fallback, so public readers resolve to viewer.
  const userId = await userIdForEmail(userEmail);
  if (userId) {
    const collabRole = collabPermToRole(await resolveNestPermission(nestId, userId));
    if (collabRole) roles.add(collabRole);
  }

  // Steward assignments — scoped to the node when one is given.
  const stewardRoles = opts?.nodeId
    ? (await resolveStewardsForNode(nestId, opts.nodeId))
        .filter(
          (r) => r.steward.userEmail.toLowerCase() === userEmail.toLowerCase(),
        )
        .map((r) => r.steward.role)
    : await getStewardRolesForUser(nestId, userEmail);
  for (const role of stewardRoles) roles.add(role);

  return [...roles];
}

// ─── PERMISSION CHECKS ──────────────────────────────────────────────────
// Resolution merges collaborator + steward roles via resolveUserRoles.
//
// Rules:
//   super-admin (access.yaml)  -> edit + access; approve like an admin steward
//   nest owner                 -> edit + access. APPROVAL is gated by the
//                                 nest's allow_self_approve flag: off ->
//                                 approvals go to assigned reviewers (the
//                                 owner can't approve via ownership alone);
//                                 on -> the owner can approve anything,
//                                 including their own submissions (seeding).
//                                 An owner who ALSO holds a reviewer/admin
//                                 steward role approves teammates' work via
//                                 that role regardless of the flag.
//   steward role=admin/reviewer-> approve + reject + access (NOT own work,
//                                 unless they're the owner and the flag is on)
//   steward role=editor        -> edit + access
//   steward role=viewer        -> access only

export type PermissionRole =
  | "super_admin"
  | "owner"
  | "admin"
  | StewardRole
  | null;

export interface PermissionResult {
  allowed: boolean;
  reason: string;
  role?: PermissionRole;
}

/**
 * Can this user manage the steward roster (assign/remove/sync)? Single
 * authority shared by REST (app.ts), MCP, and any other caller so the rule
 * lives in one place. Stewards are governed by:
 *   - open mode has no real auth — everyone is effectively owner
 *   - the license/server admin, or an access.yaml super_admin
 *   - the nest owner or an admin collaborator on THIS nest — so an owner can
 *     delegate people-management (collaborators AND stewards) by granting
 *     admin, instead of every roster change routing through the server admin
 */
export async function canManageStewards(
  nestId: string,
  userId: string,
): Promise<boolean> {
  if (config.AUTH_MODE === "open") return true;
  // resolveNestPermission already folds the license admin and access.yaml
  // super_admins into nest-level "admin", so one lookup covers server admins,
  // the nest owner, and admin collaborators — no separate email round-trip.
  const perm = await resolveNestPermission(nestId, userId);
  return perm === "owner" || perm === "admin";
}

/**
 * Can this user create a new document in the nest? Mirrors the app.ts
 * middleware's create rule: nest-wide write (owner/admin/write collaborator)
 * or a nest-scope editor steward. Used by callers that don't run through
 * that middleware (MCP) so the write gate doesn't depend on it alone.
 */
export async function canCreateInNest(nestId: string, userEmail: string): Promise<boolean> {
  if (config.AUTH_MODE === "open" || isSuperAdmin(userEmail)) return true;
  const userId = await userIdForEmail(userEmail);
  if (userId) {
    const perm = await resolveNestPermission(nestId, userId);
    if (perm === "owner" || perm === "admin" || perm === "write") return true;
  }
  return (await getStewardsForUser(nestId, userEmail)).some(
    (s) => s.role === "editor" && s.scope === "nest",
  );
}

async function getNestOwnerEmail(nestId: string): Promise<string | null> {
  const db = getDb();
  const row = await db.get(
    `SELECT u.email FROM nests n
       JOIN users u ON u.id = n.user_id
       WHERE n.id = ?`,
    [nestId],
  ) as { email: string } | undefined;
  return row?.email ?? null;
}

export async function canUserEdit(
  nestId: string,
  nodeId: string,
  userEmail: string,
): Promise<PermissionResult> {
  const roles = await resolveUserRoles(nestId, userEmail, { nodeId });
  if (roles.includes("owner")) {
    return { allowed: true, reason: "nest owner", role: "owner" };
  }
  if (isSuperAdmin(userEmail)) {
    return { allowed: true, reason: "super admin", role: "super_admin" };
  }
  if (canEditWith(roles)) {
    return {
      allowed: true,
      reason: "editor access (collaborator or steward)",
      role: roles.includes("admin") ? "admin" : "editor",
    };
  }
  return { allowed: false, reason: "no editor role on this node", role: null };
}

async function getCurrentVersionAuthor(
  nestId: string,
  nodeId: string,
): Promise<string | null> {
  const db = getDb();
  const row = await db.get(
    `SELECT author FROM node_versions
       WHERE nest_id = ? AND node_id = ?
       ORDER BY version DESC LIMIT 1`,
    [nestId, nodeId],
  ) as { author: string } | undefined;
  return row?.author ?? null;
}

/**
 * For SoD: the email that triggered the current pending review wins over
 * the original version author. The requester is the proximate "actor"
 * asking for approval, so SoD should block them — not whoever happened
 * to write an earlier edit. Returns null when no pending review exists.
 */
async function getPendingReviewRequester(
  nestId: string,
  nodeId: string,
): Promise<string | null> {
  const db = getDb();
  const row = await db.get(
    `SELECT requested_by FROM review_requests
       WHERE nest_id = ? AND node_id = ? AND status = 'pending'
       ORDER BY requested_at DESC LIMIT 1`,
    [nestId, nodeId],
  ) as { requested_by: string } | undefined;
  return row?.requested_by ?? null;
}

export async function canUserApprove(
  nestId: string,
  nodeId: string,
  userEmail: string,
): Promise<PermissionResult> {
  const roles = await resolveUserRoles(nestId, userEmail, { nodeId });
  const isOwner = roles.includes("owner");
  const isSuper = isSuperAdmin(userEmail);
  const allowSelf = await nestAllowsSelfApprove(nestId);
  // Explicit approve-capable steward role (admin or reviewer), NOT the
  // ownership-derived right. Owner-only callers resolve to ["owner"] and
  // fall through to the ownership branch below; an owner who is ALSO an
  // admin/reviewer steward keeps that role's powers here.
  const hasStewardApprove =
    roles.includes("admin") || roles.includes("reviewer");

  // The actor is the user who SUBMITTED the version for review (or the version
  // author as a fallback). We compare against review_requests.requested_by so
  // that when a teammate submits someone else's earlier edit, the original
  // author can still approve.
  const actor =
    (await getPendingReviewRequester(nestId, nodeId)) ??
    (await getCurrentVersionAuthor(nestId, nodeId));
  const isOwnSubmission =
    !!actor && actor.toLowerCase() === userEmail.toLowerCase();

  // Path 1 — explicit steward (admin/reviewer): approve teammates' work always.
  // Own submission is blocked by separation of duties, UNLESS the caller is
  // also the owner/super-admin and the nest opts into self-approve (seeding).
  if (hasStewardApprove) {
    if (isOwnSubmission && !((isOwner || isSuper) && allowSelf)) {
      return {
        allowed: false,
        reason:
          "You submitted this version for review, so you can't approve it yourself. Ask another reviewer to approve it (separation of duties).",
        role: roles.includes("admin") ? "admin" : "reviewer",
      };
    }
    return {
      allowed: true,
      reason: "reviewer access (collaborator or steward)",
      role: roles.includes("admin") ? "admin" : "reviewer",
    };
  }

  // Path 2 — ownership/super-admin without a steward role. Approval is gated by
  // the nest's allow_self_approve flag: off -> approvals go to assigned
  // reviewers; on -> the owner may approve anything, including own submissions.
  if (isOwner || isSuper) {
    if (allowSelf) {
      return {
        allowed: true,
        reason: isOwner ? "nest owner (self-approve enabled)" : "super admin",
        role: isOwner ? "owner" : "super_admin",
      };
    }
    return {
      allowed: false,
      reason:
        "Approvals go to assigned reviewers while self-approve is off. Enable self-approve in nest settings to approve directly (e.g. while seeding), or add a reviewer steward.",
      role: isOwner ? "owner" : "super_admin",
    };
  }

  // Path 3 — editor/viewer/plain collaborator: no approval rights.
  const held = primaryRole(roles);
  return {
    allowed: false,
    reason: held
      ? `You're a "${held}" on this document — only reviewers (or admins) can approve. Ask the nest owner to grant you the reviewer steward role.`
      : "You're not a steward on this document, so you can't approve it. Ask the nest owner to add you as a reviewer.",
    role: held,
  };
}

export async function canUserAccess(
  nestId: string,
  nodeId: string,
  userEmail: string,
): Promise<PermissionResult> {
  const roles = await resolveUserRoles(nestId, userEmail, { nodeId });
  if (roles.includes("owner")) {
    return { allowed: true, reason: "nest owner", role: "owner" };
  }
  if (isSuperAdmin(userEmail)) {
    return { allowed: true, reason: "super admin", role: "super_admin" };
  }
  if (canViewWith(roles)) {
    return {
      allowed: true,
      reason: "collaborator or steward access",
      role: primaryRole(roles),
    };
  }
  return { allowed: false, reason: "no collaborator or steward access", role: null };
}

// ─── SYNC FROM stewards.yaml ────────────────────────────────────────────

export async function syncFromConfig(
  nestId: string,
  config: StewardsConfig,
): Promise<number> {
  const db = getDb();
  let count = 0;

  // Deactivate existing stewards for this nest (will re-create from config)
  await db.run(
    "UPDATE stewards SET is_active = 0 WHERE nest_id = ?",
    [nestId],
  );

  // Declaring stewards via config implies governed mode — flip the flag.
  await db.run(
    "UPDATE nests SET stewardship_enabled = 1 WHERE id = ?",
    [nestId],
  );

  const addEntries = async (
    scope: StewardshipScope,
    entries: StewardEntry[],
    target?: { nodePattern?: string; tagName?: string },
  ) => {
    for (const entry of entries) {
      // Look up user by email
      const user = await db.get(
        "SELECT id FROM users WHERE email = ?",
        [entry.email],
      ) as { id: string } | undefined;

      // Legacy 'admin' role maps to 'reviewer' — matches migration 002 behavior.
      const rawRole = entry.role || "reviewer";
      const role: StewardRole =
        (rawRole as string) === "admin"
          ? "reviewer"
          : (rawRole as StewardRole);

      await assignSteward({
        nestId,
        scope,
        nodePattern: target?.nodePattern,
        tagName: target?.tagName
          ? target.tagName.trim().replace(/^#+/, "").toLowerCase()
          : undefined,
        userEmail: entry.email.toLowerCase(),
        userId: user?.id,
        role,
        assignedBy: "config",
        assignedAt: new Date().toISOString(),
        isActive: true,
      });
      count++;
    }
  };

  // Nest-level stewards
  if (config.nest) {
    await addEntries("nest", config.nest);
  }

  // Tag-level stewards
  if (config.tags) {
    for (const [tagName, entries] of Object.entries(config.tags)) {
      await addEntries("tag", entries, { tagName });
    }
  }

  // Document-level stewards
  if (config.documents) {
    for (const [docPattern, entries] of Object.entries(config.documents)) {
      await addEntries("document", entries, { nodePattern: docPattern });
    }
  }

  return count;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function rowToSteward(row: any): Steward {
  return {
    id: row.id,
    nestId: row.nest_id,
    scope: row.scope,
    nodePattern: row.node_pattern || undefined,
    tagName: row.tag_name || undefined,
    userEmail: row.user_email,
    userId: row.user_id || undefined,
    role: row.role,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
    isActive: !!row.is_active,
  };
}
