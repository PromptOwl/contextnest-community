/**
 * Governance Types — ported from PromptOwl lib/context-nest/types.ts
 *
 * These are the canonical types shared between PromptOwl and the community server.
 * PromptOwl can subscribe to this layer by implementing the same adapter interfaces.
 */

import type { ClientMetadata } from "../shared/client-metadata.js";

// Document lifecycle states. `published` is the terminal state for
// auto-publish (no-stewards) saves — engine has bumped frontmatter on
// disk and the row points at the live published version. `approved` is
// kept for legacy data + the stewards approval workflow until that
// flow is folded into `published` too.
export type DocumentLifecycleStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "published"
  | "rejected";

// Stewardship scope types (resolution priority: document > tag > nest)
export type StewardshipScope = "document" | "tag" | "nest";

// Review request priority levels
export type ReviewRequestPriority = "low" | "normal" | "high" | "urgent";

// Review request status
export type ReviewRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled";

// Steward role (maps to PromptOwl's IStewardUser.role)
// Semantics: viewer -> access only, editor -> edit, reviewer -> approve+reject+access.
export type StewardRole = "editor" | "reviewer" | "viewer";

// Document version
export interface DocumentVersion {
  version: number;
  content: string;
  editedBy: string;
  editedAt: string;
  changeNote?: string;
  status: DocumentLifecycleStatus;
  /**
   * Caller attribution for the write that sealed this version (spec §9.4) —
   * which agent, in which session. Absent when the call carried none, which is
   * every version written before the field existed and every write from a
   * caller that sends nothing: attribution is evidence a caller offers, not a
   * toll it pays.
   *
   * `editedBy` stays the authoritative authoring record; this is the caller's
   * own self-report about the call, never authenticated.
   */
  client?: ClientMetadata;
}

// Steward assignment (ported from PromptOwl ContextSteward)
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

// Comment status — comments are standalone annotations, not version states.
export type CommentStatus = "open" | "resolved";

// Optional highlight anchor — the char span a comment is attached to, so the
// UI can show it in the margin next to the highlighted text (Word/Docs style).
// start/end are document character offsets — optional because a client may
// only have the quoted text (e.g. a plain text selection with no editor offset
// mapping yet). When offsets are unknown, send just `text` and leave them null;
// don't fabricate 0/length.
export interface CommentAnchor {
  start?: number;
  end?: number;
  text?: string;
}

// Collaboration comment (CU-wdqcpzudt3). DB-only; never part of the hash chain.
export interface Comment {
  id: string;
  nestId: string;
  nodeId: string;
  version?: number; // optional: pinned to the version it was left on
  anchor?: CommentAnchor; // optional: highlighted span
  parentId?: string; // threading — reply to another comment
  author: string; // email
  body: string;
  status: CommentStatus;
  createdAt: string;
  resolvedBy?: string; // email
  resolvedAt?: string;
}

// One entry in the per-node / per-nest activity log. Aggregates "who did
// what" across comments, edits, and reviews — read-only, derived from the
// existing actor/timestamp fields on each source table.
export type ActivityType =
  | "comment"
  | "comment_resolved"
  | "edit" // a committed node version
  | "edit_proposed" // a pending external-edit suggestion ("proposed an edit")
  | "review_requested"
  | "review_resolved";

export interface ActivityEntry {
  type: ActivityType;
  nodeId: string;
  actor: string; // email of who did it
  at: string; // ISO-ish timestamp
  detail?: string; // e.g. "approved v4", change note, comment excerpt
  refId?: string; // id of the source row (comment id, review id, version no.)
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
