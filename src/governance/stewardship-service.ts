/**
 * Stewardship Service — SQLite implementation of StewardshipAdapter.
 *
 * Ported from PromptOwl's contextStewardship.ts actions + ContextSteward model.
 * Resolution hierarchy: document(1) > folder(2) > tag(3) > nest(4).
 */

import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { getAccessConfig } from "./access-service.js";
import type {
  Steward,
  ResolvedSteward,
  StewardsConfig,
  StewardEntry,
  StewardshipScope,
  StewardRole,
} from "./types.js";

// ─── CRUD ───────────────────────────────────────────────────────────────

export function assignSteward(data: Omit<Steward, "id">): Steward {
  const db = getDb();
  const id = uuid();

  db.prepare(
    `INSERT INTO stewards
     (id, nest_id, scope, node_pattern, tag_name, user_email, user_id, role, can_approve, can_reject, assigned_by, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    data.nestId,
    data.scope,
    data.nodePattern || null,
    data.tagName || null,
    data.userEmail,
    data.userId || null,
    data.role,
    data.canApprove ? 1 : 0,
    data.canReject ? 1 : 0,
    data.assignedBy,
    data.isActive ? 1 : 0,
  );

  return { ...data, id };
}

export function removeSteward(id: string): void {
  const db = getDb();
  db.prepare("UPDATE stewards SET is_active = 0 WHERE id = ?").run(id);
}

export function getSteward(id: string): Steward | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM stewards WHERE id = ?").get(id) as any;
  return row ? rowToSteward(row) : null;
}

export function getStewardsForNest(nestId: string): Steward[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM stewards WHERE nest_id = ? AND is_active = 1")
    .all(nestId) as any[];
  return rows.map(rowToSteward);
}

export function getStewardsForScope(params: {
  nestId: string;
  scope?: StewardshipScope;
  scopeTarget?: string;
}): Steward[] {
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

  return (db.prepare(sql).all(...args) as any[]).map(rowToSteward);
}

/**
 * List stewards with filters. Mirrors PromptOwl StewardsListPage filters.
 */
export function listStewards(params: {
  nestId: string;
  scope?: StewardshipScope;
  search?: string;
}): Steward[] {
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
  return (db.prepare(sql).all(...args) as any[]).map(rowToSteward);
}

/**
 * Create a steward record for a (scope, target) with N users.
 * Inserts one row per user — partial unique indexes enforce idempotency.
 * Returns the inserted rows (existing rows for a duplicate email are skipped).
 */
// Steward role → nest collaborator permission. Editors get write so they can
// modify documents in the UI; reviewers/viewers only need read because their
// approve/reject path goes through the stewardship API, not direct edits.
function rolePermission(role: StewardRole | undefined): "read" | "write" {
  return role === "editor" ? "write" : "read";
}

// Ensure the steward email is a real user in the system AND a collaborator on
// the nest. Without this, an assigned steward cannot see the nest in their
// list (listSharedNests JOINs nest_collaborators), so the assignment is
// invisible to them. Mirrors the placeholder-user pattern used in
// sharing-routes.ts when sharing by email.
async function ensureCollaborator(
  nestId: string,
  email: string,
  permission: "read" | "write" | "admin",
  grantedBy: string,
): Promise<void> {
  const db = getDb();
  let userRow = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(email) as { id: string } | undefined;

  if (!userRow) {
    const { hashPassword } = await import("../auth/keys.js");
    const newId = uuid();
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, is_invited) VALUES (?, ?, ?, ?, 1)",
    ).run(newId, email, null, await hashPassword(uuid()));
    userRow = { id: newId };
  }

  const nestRow = db
    .prepare("SELECT user_id FROM nests WHERE id = ?")
    .get(nestId) as { user_id: string } | undefined;
  if (nestRow && nestRow.user_id === userRow.id) return; // owner; no collab row needed

  const existing = db
    .prepare(
      "SELECT id FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
    )
    .get(nestId, userRow.id) as { id: string } | undefined;
  if (existing) return;

  // granted_by FK -> users(id). The route passes the assigner's email, so
  // translate to user id; fall back to the nest owner if the email isn't
  // registered (e.g. open-mode "admin@localhost").
  const granterRow = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(grantedBy) as { id: string } | undefined;
  const granterId = granterRow?.id ?? nestRow?.user_id;
  if (!granterId) return; // nest gone; nothing to grant against

  db.prepare(
    "INSERT INTO nest_collaborators (id, nest_id, user_id, permission, granted_by) VALUES (?, ?, ?, ?, ?)",
  ).run(uuid(), nestId, userRow.id, permission, granterId);
}

export async function createStewardRecord(params: {
  nestId: string;
  scope: StewardshipScope;
  documentId?: string;
  folderPath?: string;
  tagName?: string;
  users: Array<{
    email: string;
    role?: StewardRole;
    canApprove?: boolean;
    canReject?: boolean;
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
    case "folder":
      if (!params.folderPath) throw new Error("folderPath required for folder scope");
      nodePattern = params.folderPath;
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

  for (const user of params.users) {
    const email = user.email.trim().toLowerCase();
    if (!email) continue;

    // Check for existing active row (idempotent).
    const existing = db
      .prepare(
        `SELECT * FROM stewards
         WHERE nest_id = ? AND is_active = 1 AND scope = ? AND user_email = ?
           AND COALESCE(node_pattern, '') = COALESCE(?, '')
           AND COALESCE(tag_name, '') = COALESCE(?, '')`,
      )
      .get(
        params.nestId,
        params.scope,
        email,
        nodePattern ?? null,
        tagName ?? null,
      ) as any;

    if (existing) {
      results.push(rowToSteward(existing));
      continue;
    }

    const userRow = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(email) as { id: string } | undefined;

    const created = assignSteward({
      nestId: params.nestId,
      scope: params.scope,
      nodePattern,
      tagName,
      userEmail: email,
      userId: userRow?.id,
      role: user.role ?? "reviewer",
      canApprove: user.canApprove !== false,
      canReject: user.canReject !== false,
      assignedBy: params.assignedBy,
      assignedAt: new Date().toISOString(),
      isActive: true,
    });
    results.push(created);

    await ensureCollaborator(
      params.nestId,
      email,
      rolePermission(user.role),
      params.assignedBy,
    );
  }

  // If adding any stewards, ensure governed mode is on.
  db.prepare(
    "UPDATE nests SET stewardship_enabled = 1 WHERE id = ? AND stewardship_enabled = 0",
  ).run(params.nestId);

  return results;
}

// ─── STEWARD RESOLUTION ─────────────────────────────────────────────────
// Ported from PromptOwl's resolveStewardsForDocument aggregation pipeline.
// Priority: document(1) > folder(2) > tag(3) > nest(4).
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

export function resolveStewardsForNode(
  nestId: string,
  nodeId: string,
): ResolvedSteward[] {
  return resolve(nestId, nodeId).stewards;
}

export function resolveStewardsWithFallback(
  nestId: string,
  nodeId: string,
): ResolveResult {
  return resolve(nestId, nodeId);
}

function resolve(nestId: string, nodeId: string): ResolveResult {
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
    can_approve: number;
    can_reject: number;
    assigned_by: string;
    assigned_at: string;
    is_active: number;
    priority: number;
    match_source: string;
  };

  // Document: exact match on node_pattern (no globs — keep SQL simple).
  // Folder: path-prefix match; folder rows without '*' use `node_pattern || '/%'`,
  //   legacy globs (containing '*') are resolved in JS below.
  // Tag: JOIN on node_tag_index for fast tag lookup.
  // Nest: unconditional.
  const rows = db
    .prepare(
      `
      SELECT s.*, 1 AS priority, ('document: ' || s.node_pattern) AS match_source
        FROM stewards s
        WHERE s.nest_id = ? AND s.is_active = 1 AND s.scope = 'document'
          AND s.node_pattern = ?
      UNION ALL
      SELECT s.*, 2 AS priority, ('folder: ' || s.node_pattern) AS match_source
        FROM stewards s
        WHERE s.nest_id = ? AND s.is_active = 1 AND s.scope = 'folder'
          AND s.node_pattern IS NOT NULL
          AND instr(s.node_pattern, '*') = 0
          AND (
            ? LIKE s.node_pattern || '/%'
            OR s.node_pattern = ?
          )
      UNION ALL
      SELECT s.*, 3 AS priority, ('tag: ' || s.tag_name) AS match_source
        FROM stewards s
        JOIN node_tag_index nt
          ON nt.nest_id = s.nest_id
         AND nt.tag_name = s.tag_name
        WHERE s.nest_id = ? AND s.is_active = 1 AND s.scope = 'tag'
          AND nt.node_id = ?
      UNION ALL
      SELECT s.*, 4 AS priority, 'nest-level steward' AS match_source
        FROM stewards s
        WHERE s.nest_id = ? AND s.is_active = 1 AND s.scope = 'nest'
      ORDER BY priority ASC, user_email ASC
      `,
    )
    .all(
      nestId, nodeId,                  // document branch
      nestId, nodeId, nestId,          // folder branch (path-prefix OR whole-nest folder)
      nestId, nodeId,                  // tag branch
      nestId,                          // nest branch
    ) as Row[];

  const resolved: ResolvedSteward[] = rows.map((row) => ({
    steward: rowToSteward(row),
    priority: row.priority,
    source: row.match_source,
  }));

  // Legacy fallback: folder rows containing glob wildcards are rare but
  // still supported — scan them in JS against the node ID.
  const legacyFolderGlobs = db
    .prepare(
      `SELECT * FROM stewards
       WHERE nest_id = ? AND is_active = 1 AND scope = 'folder'
         AND node_pattern IS NOT NULL AND instr(node_pattern, '*') > 0`,
    )
    .all(nestId) as any[];
  for (const row of legacyFolderGlobs) {
    if (globMatch(nodeId, row.node_pattern)) {
      resolved.push({
        steward: rowToSteward(row),
        priority: 2,
        source: `folder: ${row.node_pattern}`,
      });
    }
  }

  if (legacyFolderGlobs.length > 0) {
    resolved.sort((a, b) => a.priority - b.priority);
  }

  if (resolved.length > 0) {
    return { stewards: resolved, fallbackToOwner: false };
  }

  // Fallback: nest owner is the implicit steward when nothing resolves.
  const owner = db
    .prepare(
      `SELECT u.email FROM nests n
       JOIN users u ON u.id = n.user_id
       WHERE n.id = ?`,
    )
    .get(nestId) as { email: string } | undefined;

  return {
    stewards: [],
    fallbackToOwner: true,
    ownerEmail: owner?.email,
  };
}

// ─── PERMISSION CHECKS ──────────────────────────────────────────────────
// Ported 1:1 from PromptOwl contextStewardship.ts canUserEditDocument /
// canUserApproveDocument / canUserAccessDocument.
//
// Rules:
//   super-admin (access.yaml)  -> all allowed
//   nest owner                 -> edit + access, NEVER approve (separation-of-duties)
//   steward role=reviewer      -> approve + reject + access
//   steward role=editor        -> edit + access
//   steward role=viewer        -> access only

export type PermissionRole =
  | "super_admin"
  | "owner"
  | StewardRole
  | null;

export interface PermissionResult {
  allowed: boolean;
  reason: string;
  role?: PermissionRole;
}

function isSuperAdmin(userEmail: string): boolean {
  const cfg = getAccessConfig();
  return !!cfg?.super_admins?.includes(userEmail);
}

function getNestOwnerEmail(nestId: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.email FROM nests n
       JOIN users u ON u.id = n.user_id
       WHERE n.id = ?`,
    )
    .get(nestId) as { email: string } | undefined;
  return row?.email ?? null;
}

export function canUserEdit(
  nestId: string,
  nodeId: string,
  userEmail: string,
): PermissionResult {
  if (isSuperAdmin(userEmail)) {
    return { allowed: true, reason: "super admin", role: "super_admin" };
  }
  const owner = getNestOwnerEmail(nestId);
  if (owner && owner.toLowerCase() === userEmail.toLowerCase()) {
    return { allowed: true, reason: "nest owner", role: "owner" };
  }

  const resolved = resolveStewardsForNode(nestId, nodeId);
  const match = resolved.find(
    (r) =>
      r.steward.userEmail.toLowerCase() === userEmail.toLowerCase() &&
      (r.steward.role === "editor" || r.steward.role === "reviewer"),
  );
  if (match) {
    return { allowed: true, reason: match.source, role: match.steward.role };
  }
  return { allowed: false, reason: "no editor/reviewer role on this node", role: null };
}

function getCurrentVersionAuthor(
  nestId: string,
  nodeId: string,
): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT author FROM node_versions
       WHERE nest_id = ? AND node_id = ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(nestId, nodeId) as { author: string } | undefined;
  return row?.author ?? null;
}

export function canUserApprove(
  nestId: string,
  nodeId: string,
  userEmail: string,
): PermissionResult {
  if (isSuperAdmin(userEmail)) {
    return { allowed: true, reason: "super admin", role: "super_admin" };
  }

  // Check steward assignment first — a user who isn't a steward can't approve
  // regardless of authorship, and the "not a steward" message is more useful.
  const resolved = resolveStewardsForNode(nestId, nodeId);
  if (resolved.length === 0) {
    return {
      allowed: false,
      reason: "no stewards configured for this node",
      role: null,
    };
  }

  const match = resolved.find(
    (r) =>
      r.steward.userEmail.toLowerCase() === userEmail.toLowerCase() &&
      r.steward.role === "reviewer" &&
      r.steward.canApprove,
  );
  if (!match) {
    return {
      allowed: false,
      reason: "not a reviewer steward for this node",
      role: null,
    };
  }

  // Separation of duties: even a reviewer can't approve their own edit.
  const author = getCurrentVersionAuthor(nestId, nodeId);
  if (author && author.toLowerCase() === userEmail.toLowerCase()) {
    return {
      allowed: false,
      reason: "cannot approve a version you authored (separation of duties)",
      role: "reviewer",
    };
  }

  return { allowed: true, reason: match.source, role: "reviewer" };
}

export function canUserAccess(
  nestId: string,
  nodeId: string,
  userEmail: string,
): PermissionResult {
  if (isSuperAdmin(userEmail)) {
    return { allowed: true, reason: "super admin", role: "super_admin" };
  }
  const owner = getNestOwnerEmail(nestId);
  if (owner && owner.toLowerCase() === userEmail.toLowerCase()) {
    return { allowed: true, reason: "nest owner", role: "owner" };
  }

  const resolved = resolveStewardsForNode(nestId, nodeId);
  const match = resolved.find(
    (r) => r.steward.userEmail.toLowerCase() === userEmail.toLowerCase(),
  );
  if (match) {
    return { allowed: true, reason: match.source, role: match.steward.role };
  }
  return { allowed: false, reason: "no steward assignment", role: null };
}

// Kept for legacy folder-glob fallback only.
function globMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*") +
      "$",
  );
  return regex.test(value);
}

// ─── SYNC FROM stewards.yaml ────────────────────────────────────────────

export function syncFromConfig(
  nestId: string,
  config: StewardsConfig,
): number {
  const db = getDb();
  let count = 0;

  // Deactivate existing stewards for this nest (will re-create from config)
  db.prepare(
    "UPDATE stewards SET is_active = 0 WHERE nest_id = ?",
  ).run(nestId);

  // Declaring stewards via config implies governed mode — flip the flag.
  db.prepare(
    "UPDATE nests SET stewardship_enabled = 1 WHERE id = ?",
  ).run(nestId);

  const addEntries = (
    scope: StewardshipScope,
    entries: StewardEntry[],
    target?: { nodePattern?: string; tagName?: string },
  ) => {
    for (const entry of entries) {
      // Look up user by email
      const user = db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(entry.email) as { id: string } | undefined;

      // Legacy 'admin' role maps to 'reviewer' — matches migration 002 behavior.
      const rawRole = entry.role || "reviewer";
      const role: StewardRole =
        (rawRole as string) === "admin"
          ? "reviewer"
          : (rawRole as StewardRole);

      assignSteward({
        nestId,
        scope,
        nodePattern: target?.nodePattern,
        tagName: target?.tagName
          ? target.tagName.trim().replace(/^#+/, "").toLowerCase()
          : undefined,
        userEmail: entry.email.toLowerCase(),
        userId: user?.id,
        role,
        canApprove: entry.can_approve !== false,
        canReject: entry.can_reject !== false,
        assignedBy: "config",
        assignedAt: new Date().toISOString(),
        isActive: true,
      });
      count++;
    }
  };

  // Nest-level stewards
  if (config.nest) {
    addEntries("nest", config.nest);
  }

  // Folder-level stewards
  if (config.folders) {
    for (const [pattern, entries] of Object.entries(config.folders)) {
      addEntries("folder", entries, { nodePattern: pattern });
    }
  }

  // Tag-level stewards
  if (config.tags) {
    for (const [tagName, entries] of Object.entries(config.tags)) {
      addEntries("tag", entries, { tagName });
    }
  }

  // Document-level stewards
  if (config.documents) {
    for (const [docPattern, entries] of Object.entries(config.documents)) {
      addEntries("document", entries, { nodePattern: docPattern });
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
    canApprove: !!row.can_approve,
    canReject: !!row.can_reject,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
    isActive: !!row.is_active,
  };
}
