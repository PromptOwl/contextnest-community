/**
 * Nest capability flags, derived in one place from what GET /nests/:id returns.
 *
 * Pulled out of NestView so other nest-scoped views (the board, and anything
 * added later) gate on the same rule instead of re-deriving it. Coarse UI
 * gating only — the server still enforces per node, so a mistake here is a
 * confusing affordance, not a security hole.
 */

/** The slice of a steward row the rules need. */
export interface CapSteward {
  role: string;
  scope: string;
}

export interface NestCapsInput {
  /** Caller's merged effective roles (collaborator + steward), nest-wide. */
  roles: string[];
  /** Caller's nest-level collaborator permission. */
  permission: string | null;
  /** Caller's own scoped steward rows. */
  myStewards: CapSteward[];
  isOwner: boolean;
  isAdmin: boolean;
}

export interface NestCaps {
  /** Assign stewards + share with collaborators (owner/admin). */
  canManage: boolean;
  /** Nest-wide write via a collaborator grant. */
  collabCanWrite: boolean;
  /** Approve/reject (owner/admin or reviewer steward). */
  canReviewDocs: boolean;
  /** Create/edit documents (nest-wide write or nest-scope editor). */
  canEditDocs: boolean;
  /** No write/review/manage — public visitors and plain 'read' collaborators. */
  isReadOnly: boolean;
}

export function deriveNestCaps({
  roles,
  permission,
  myStewards,
  isOwner,
  isAdmin,
}: NestCapsInput): NestCaps {
  const hasRole = (...r: string[]) => roles.some((x) => r.includes(x));
  const canManage = isOwner || isAdmin || hasRole("owner", "admin");
  const collabCanWrite =
    permission === "owner" || permission === "admin" || permission === "write";
  const canReviewDocs =
    canManage || myStewards.some((s) => s.role === "reviewer");
  const canEditDocs =
    canManage ||
    collabCanWrite ||
    myStewards.some((s) => s.role === "editor" && s.scope === "nest");
  const isReadOnly = !canEditDocs && !canReviewDocs && !canManage;
  return { canManage, collabCanWrite, canReviewDocs, canEditDocs, isReadOnly };
}
