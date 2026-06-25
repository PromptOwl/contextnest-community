/**
 * Governance Types — community server's governance surface.
 *
 * Shared shapes (role, scope, lifecycle) re-exported from `lib/core/types.js`
 * which in turn re-exports from `@promptowl/contextnest-engine`. This file
 * adds community-only shapes (Steward record, ReviewRequest, etc.) and the
 * SQLite-backed adapter contract.
 *
 * Sister apps (TheOwl) consume from `@promptowl/contextnest-community/core`,
 * not from this file directly.
 */

import type {
  StewardRole,
  StewardshipScope,
  DocumentLifecycleStatus,
  ReviewRequestPriority,
  ReviewRequestStatus,
} from "../lib/core/types.js";

export type {
  StewardRole,
  StewardshipScope,
  DocumentLifecycleStatus,
  ReviewRequestPriority,
  ReviewRequestStatus,
};

// Document version
export interface DocumentVersion {
  version: number;
  content: string;
  editedBy: string;
  editedAt: string;
  changeNote?: string;
  status: DocumentLifecycleStatus;
}

/**
 * Steward assignment — community's SQLite shape.
 *
 * Mirrors the engine's `SingleUserSteward` (one row per user grant) but
 * adds community-only fields used by the REST + UI surface:
 *   - `nodePattern` (engine uses `documentId`) — kept for back-compat with
 *     existing SQLite rows and the stewards.yaml import path
 *   - `nodeTitle` — UI-side enrichment resolved from on-disk frontmatter
 *     by `enrichWithTitles`, never persisted
 *
 * Engine `SingleUserSteward` is the canonical Mongo-backed shape for
 * consumers using `@promptowl/contextnest-engine` directly. This community
 * type stays distinct because the SQLite schema, REST DTO, and UI need the
 * extra fields above.
 */
export interface Steward {
  id: string;
  nestId: string;
  scope: StewardshipScope;
  // Scope targets (only one is set based on scope)
  nodePattern?: string; // exact node id for document scope
  nodeTitle?: string; // resolved frontmatter title for document scope (listStewards only)
  tagName?: string; // tag scope
  // Assignment
  userEmail: string;
  userId?: string; // resolved from email when user exists
  role: StewardRole;
  assignedBy: string;
  assignedAt: string;
  isActive: boolean;
}

// Resolved steward with priority (returned from resolution)
export interface ResolvedSteward {
  steward: Steward;
  priority: number; // 1=document, 2=tag, 3=nest
  source: string; // human-readable reason (e.g. "tag: #architecture")
}

// Review request (ported from PromptOwl ReviewRequest)
export interface ReviewRequest {
  id: string;
  nestId: string;
  nodeId: string;
  title?: string; // resolved from node frontmatter when listed via getReviewQueue
  version: number;
  requestedBy: string; // email
  requestedAt: string;
  requestNote?: string;
  status: ReviewRequestStatus;
  resolvedBy?: string; // email
  resolvedAt?: string;
  resolutionNote?: string;
  priority: ReviewRequestPriority;
}

// User reference
export interface UserRef {
  id: string;
  email: string;
  name?: string;
}

// Version conflict info (returned on 409)
export interface VersionConflict {
  error: string;
  yourVersion: number;
  currentVersion: number;
  updatedBy: string;
  updatedAt: string;
  rejectedContent: string;
}

// Node with governance metadata (extends the basic node response)
export interface GovernedNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
  content: string;
  version: number;
  status: DocumentLifecycleStatus;
  approvedVersion: number | null;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  // Resolved stewards for this node
  stewards?: ResolvedSteward[];
}

// stewards.yaml format (ported from PromptOwl SerializedStewardsConfig)
export interface StewardsConfig {
  version: number;
  nest?: StewardEntry[];
  tags?: Record<string, StewardEntry[]>;
  documents?: Record<string, StewardEntry[]>;
}

export interface StewardEntry {
  email: string;
  role?: StewardRole;
}

// access.yaml format (server-level config)
export interface AccessConfig {
  mode?: "open" | "restricted";
  allowed_users?: string[]; // email list, supports wildcards like "*.acme.com"
  groups?: Record<
    string,
    {
      members: string[];
      default_permission: "read" | "write" | "admin";
    }
  >;
  super_admins?: string[];
}
