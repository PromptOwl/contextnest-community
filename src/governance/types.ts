/**
 * Governance Types — ported from PromptOwl lib/context-nest/types.ts
 *
 * These are the canonical types shared between PromptOwl and the community server.
 * PromptOwl can subscribe to this layer by implementing the same adapter interfaces.
 */

// Document lifecycle states
export type DocumentLifecycleStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected";

// Stewardship scope types (resolution priority: document > folder > tag > nest)
export type StewardshipScope = "document" | "folder" | "tag" | "nest";

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
}

// Steward assignment (ported from PromptOwl ContextSteward)
export interface Steward {
  id: string;
  nestId: string;
  scope: StewardshipScope;
  // Scope targets (only one is set based on scope)
  nodePattern?: string; // glob pattern for document/folder scope (e.g. "nodes/api-*")
  tagName?: string; // tag scope
  // Assignment
  userEmail: string;
  userId?: string; // resolved from email when user exists
  role: StewardRole;
  canApprove: boolean;
  canReject: boolean;
  assignedBy: string;
  assignedAt: string;
  isActive: boolean;
}

// Resolved steward with priority (returned from resolution)
export interface ResolvedSteward {
  steward: Steward;
  priority: number; // 1=document, 2=folder, 3=tag, 4=nest
  source: string; // human-readable reason (e.g. "tag: #architecture")
}

// Review request (ported from PromptOwl ReviewRequest)
export interface ReviewRequest {
  id: string;
  nestId: string;
  nodeId: string;
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
  folders?: Record<string, StewardEntry[]>;
  tags?: Record<string, StewardEntry[]>;
  documents?: Record<string, StewardEntry[]>;
}

export interface StewardEntry {
  email: string;
  role?: StewardRole;
  can_approve?: boolean;
  can_reject?: boolean;
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
