/**
 * Pure permission decision tree for steward / collaborator / owner roles.
 *
 * Extracted from `governance/stewardship-service.ts` so the canEdit /
 * canApprove / canAccess decision rules live in ONE place, are testable
 * without a database, and can be reused by any storage backend (SQLite
 * in community, MongoDB in TheOwl, anything else later).
 *
 * The SQL-bound service supplies the inputs (resolved roles, ownership
 * facts, submission author); this module owns only the if/else logic.
 *
 * Decision rules (canonical):
 *
 *   canEdit
 *     - owner OR super_admin: yes
 *     - else if any of {owner, admin, editor} in roles: yes
 *     - else: no
 *
 *   canApprove
 *     - has explicit steward approve role (admin | reviewer): yes,
 *       UNLESS the caller submitted this version themselves AND
 *       (caller is owner/super_admin AND nest allows self-approve) is false.
 *       Separation of duties: a submitter can't approve their own work.
 *     - else if owner OR super_admin:
 *         - nest allows self-approve: yes
 *         - else: no, route to assigned reviewers
 *     - else: no (held role explained in the reason)
 *
 *   canAccess
 *     - owner OR super_admin: yes
 *     - else if any role granting view (canViewWith): yes
 *     - else: no
 */

import {
  type EffectiveRole,
  canEditWith,
  canViewWith,
  primaryRole,
} from "../roles.js";
import type { StewardRole } from "../types.js";

// Permission role label returned by the canonical decision tree. Mirrors
// `governance/stewardship-service.ts#PermissionRole` so the surface is
// identical across SQLite + Mongo backends.
export type PermissionRole =
  | "super_admin"
  | "owner"
  | "admin"
  | StewardRole
  | null;

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
  role?: PermissionRole;
}

/**
 * Inputs the decision tree needs. Backend fetches each field once, then
 * hands them to the pure helpers — no further I/O in this module.
 */
export interface PermissionContext {
  /** Effective roles merged from collaborator + steward rows. */
  roles: EffectiveRole[];
  /** True if caller is the access.yaml super_admin. */
  isSuperAdmin: boolean;
  /** True if caller is the nest owner. */
  isOwner: boolean;
  /** Nest opts-in to self-approval (owner approving own work). */
  allowSelfApprove?: boolean;
  /** True when caller submitted the version under review. */
  isOwnSubmission?: boolean;
}

// ─── canEdit ────────────────────────────────────────────────────────────

export function canEditPure(ctx: PermissionContext): PermissionDecision {
  if (ctx.roles.includes("owner")) {
    return { allowed: true, reason: "nest owner", role: "owner" };
  }
  if (ctx.isSuperAdmin) {
    return { allowed: true, reason: "super admin", role: "super_admin" };
  }
  if (canEditWith(ctx.roles)) {
    return {
      allowed: true,
      reason: "editor access (collaborator or steward)",
      role: ctx.roles.includes("admin") ? "admin" : "editor",
    };
  }
  return { allowed: false, reason: "no editor role on this node", role: null };
}

// ─── canApprove ─────────────────────────────────────────────────────────

export function canApprovePure(ctx: PermissionContext): PermissionDecision {
  const isOwner = ctx.isOwner || ctx.roles.includes("owner");
  const isSuper = ctx.isSuperAdmin;
  const allowSelf = ctx.allowSelfApprove ?? false;
  const isOwnSubmission = ctx.isOwnSubmission ?? false;

  // Explicit approve-capable steward role (admin or reviewer), NOT the
  // ownership-derived right. An owner who is ALSO an admin/reviewer
  // steward keeps that role's powers here.
  const hasStewardApprove =
    ctx.roles.includes("admin") || ctx.roles.includes("reviewer");

  // Path 1 — explicit steward (admin/reviewer): approve teammates' work
  // always. Own submission is blocked by separation of duties UNLESS the
  // caller is also the owner/super-admin AND the nest opts into
  // self-approve (seeding workflow).
  if (hasStewardApprove) {
    if (isOwnSubmission && !((isOwner || isSuper) && allowSelf)) {
      return {
        allowed: false,
        reason:
          "You submitted this version for review, so you can't approve it yourself. Ask another reviewer to approve it (separation of duties).",
        role: ctx.roles.includes("admin") ? "admin" : "reviewer",
      };
    }
    return {
      allowed: true,
      reason: "reviewer access (collaborator or steward)",
      role: ctx.roles.includes("admin") ? "admin" : "reviewer",
    };
  }

  // Path 2 — ownership / super-admin without a steward role. Approval is
  // gated by the nest's allow_self_approve flag.
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

  // Path 3 — editor / viewer / plain collaborator: no approval rights.
  const held = primaryRole(ctx.roles);
  return {
    allowed: false,
    reason: held
      ? `You're a "${held}" on this document — only reviewers (or admins) can approve. Ask the nest owner to grant you the reviewer steward role.`
      : "You're not a steward on this document, so you can't approve it. Ask the nest owner to add you as a reviewer.",
    role: held,
  };
}

// ─── canAccess ──────────────────────────────────────────────────────────

export function canAccessPure(ctx: PermissionContext): PermissionDecision {
  if (ctx.roles.includes("owner")) {
    return { allowed: true, reason: "nest owner", role: "owner" };
  }
  if (ctx.isSuperAdmin) {
    return { allowed: true, reason: "super admin", role: "super_admin" };
  }
  if (canViewWith(ctx.roles)) {
    return {
      allowed: true,
      reason: "collaborator or steward access",
      role: primaryRole(ctx.roles),
    };
  }
  return {
    allowed: false,
    reason: "no collaborator or steward access",
    role: null,
  };
}

// ─── Resolved-roles merge ────────────────────────────────────────────────

/**
 * Inputs needed to build the effective-role array. Each field is one of:
 *   - a fact the backend resolved (isOwner, isSuperAdmin)
 *   - a list it fetched (collabRole, stewardRoles)
 *
 * The merge rules are pure: a role appears at most once even if the same
 * role comes from both collaborator and steward sources.
 */
export interface MergeRolesInput {
  /** Collaborator permission mapped to an EffectiveRole, or null. */
  collabRole: EffectiveRole | null;
  /** Steward roles resolved for this user (already scoped to node when relevant). */
  stewardRoles: StewardRole[];
  isSuperAdmin: boolean;
  isOwner: boolean;
}

export function mergeEffectiveRoles(input: MergeRolesInput): EffectiveRole[] {
  const roles = new Set<EffectiveRole>();
  if (input.isSuperAdmin) roles.add("admin");
  if (input.isOwner) roles.add("owner");
  if (input.collabRole) roles.add(input.collabRole);
  for (const r of input.stewardRoles) roles.add(r);
  return [...roles];
}

// ─── Resolved-steward priority sort ─────────────────────────────────────

/**
 * Sort resolved stewards by resolution priority (document > tag > nest),
 * then by email so deterministic. The SQL path orders this implicitly;
 * Mongo / Postgres / in-memory backends call this to guarantee parity.
 */
export interface PrioritySortable {
  priority: number;
  steward: { userEmail: string };
}

export function sortResolvedStewards<T extends PrioritySortable>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.steward.userEmail.localeCompare(b.steward.userEmail);
  });
}
