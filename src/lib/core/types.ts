/**
 * Shared governance types — canonical surface for sister apps.
 *
 * Source-of-truth chain (per ADR-0001 in the PromptOwl engineering vault):
 *
 *   @promptowl/contextnest-engine   ← canonical
 *     └─ StewardRole, StewardshipScope, Status (re-exported here
 *        as DocumentLifecycleStatus)
 *   @promptowl/contextnest-community/core   ← re-exports + community-only
 *     extras (ReviewRequest enums, StewardEntry, etc.)
 *   TheOwl + other apps   ← consume from community/core
 *
 * Engine is the single canonical home for the role + scope + lifecycle
 * shapes that any consumer of the Context Nest stack needs. Community
 * adds review-request and config-file shapes that the engine doesn't
 * model (community ships a full REST + SQLite governance server; engine
 * is just the doc/version/integrity library).
 */

// Inlined to match engine's `StewardRole`, `StewardshipScope`, and `Status`
// shapes exactly. Engine 1.2.0+ is the canonical home; once community's
// `@promptowl/contextnest-engine` dep is bumped to ^1.2.0, swap these to:
//   import type { StewardRole, StewardshipScope, Status as DocumentLifecycleStatus }
//     from "@promptowl/contextnest-engine";
// Until then, the literal unions stay here so older published engine
// versions (1.1.x, which has no `StewardshipScope` export) keep building.

/** Editor / reviewer / viewer. Canonical source: engine 1.2.0+. */
export type StewardRole = "editor" | "reviewer" | "viewer";

/** Document / tag / nest. Canonical source: engine 1.2.0+. */
export type StewardshipScope = "document" | "tag" | "nest";

/**
 * 5-state document lifecycle:
 *   draft | pending_review | approved | published | rejected
 *
 * Matches engine's `Status` shape; consumers should import this name from
 * community/core (not redefine it).
 */
export type DocumentLifecycleStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "published"
  | "rejected";

export type ReviewRequestPriority = "low" | "normal" | "high" | "urgent";

export type ReviewRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled";

export interface DocumentVersion {
  version: number;
  content: string;
  editedBy: string;
  editedAt: string;
  changeNote?: string;
}

export interface UserRef {
  id: string;
  email: string;
  name?: string;
}

export interface VersionConflict {
  error: string;
  yourVersion: number;
  currentVersion: number;
  updatedBy: string;
  updatedAt: string;
  rejectedContent: string;
}

export interface StewardEntry {
  email: string;
  role?: StewardRole;
}

export interface StewardsConfig {
  version: number;
  nest?: StewardEntry[];
  tags?: Record<string, StewardEntry[]>;
  documents?: Record<string, StewardEntry[]>;
}
