/**
 * Governance — pure helpers + storage adapter interfaces.
 *
 * Anything backend-agnostic lives here so community (SQLite) and TheOwl
 * (MongoDB) consume the same resolution math, decision tree, and adapter
 * contracts. Implementations stay per-repo.
 *
 * What this barrel exports:
 *   - Permission decision helpers (canEditPure, canApprovePure,
 *     canAccessPure) — pure if/else over a `PermissionContext`.
 *   - Effective-role merger (mergeEffectiveRoles) — combine collaborator +
 *     steward + ownership into a single role array.
 *   - Resolved-steward priority sort (sortResolvedStewards) — guarantees
 *     a deterministic order across any backend.
 *   - The governance types + adapter interfaces (re-exported from the
 *     existing community sources so consumers do not need a separate
 *     dependency).
 */

export * from "./permissions.js";

// Re-export ONLY the governance-specific types that aren't already in
// `core/types.ts`. The overlapping names (`StewardRole`, `StewardEntry`,
// `StewardsConfig`, `UserRef`, `ReviewRequestPriority`,
// `ReviewRequestStatus`, `VersionConflict`, `DocumentVersion`) come from
// `core/types.ts` — keep one source of truth per name and avoid TS2308
// ambiguous-re-export errors.
export type {
  DocumentLifecycleStatus,
  StewardshipScope,
  Steward,
  ResolvedSteward,
  ReviewRequest,
  GovernedNode,
  AccessConfig,
} from "../../../governance/types.js";

export type {
  StewardshipAdapter,
  ReviewAdapter,
  VersionAdapter,
  AccessAdapter,
  PermissionChecker,
} from "../../../governance/adapters.js";
