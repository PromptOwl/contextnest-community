/**
 * Governance Adapter Interfaces — ported from PromptOwl lib/context-nest/adapters.ts
 *
 * These interfaces define the governance layer contract. The community server
 * provides a SQLite implementation. PromptOwl provides a MongoDB implementation.
 * Any consumer can implement these to plug into the governance system.
 */

import type {
  Steward,
  ResolvedSteward,
  ReviewRequest,
  ReviewRequestPriority,
  ReviewRequestStatus,
  DocumentLifecycleStatus,
  DocumentVersion,
  StewardshipScope,
  UserRef,
  GovernedNode,
  StewardsConfig,
  AccessConfig,
} from "./types.js";

/**
 * Stewardship storage — manage steward assignments and resolution.
 * Ported from PromptOwl's StewardshipStorageAdapter.
 */
export interface StewardshipAdapter {
  // Steward CRUD
  assignSteward(data: Omit<Steward, "id">): Promise<Steward>;
  removeSteward(id: string): Promise<void>;
  getSteward(id: string): Promise<Steward | null>;

  // Queries
  getStewardsForNest(nestId: string): Promise<Steward[]>;
  getStewardsForScope(params: {
    nestId: string;
    scope?: StewardshipScope;
    scopeTarget?: string;
  }): Promise<Steward[]>;

  // Critical: resolve who can approve a specific node.
  // Reads tags from the node_tag_index — callers no longer supply them.
  resolveStewardsForNode(
    nestId: string,
    nodeId: string,
  ): Promise<ResolvedSteward[]>;

  // Bulk sync from stewards.yaml
  syncFromConfig(nestId: string, config: StewardsConfig): Promise<number>;
}

/**
 * Review workflow — submit, approve, reject, queue.
 * Ported from PromptOwl's documentLifecycle actions.
 */
export interface ReviewAdapter {
  // Lifecycle actions
  submitForReview(params: {
    nestId: string;
    nodeId: string;
    version: number;
    requestedBy: string;
    note?: string;
    priority?: ReviewRequestPriority;
  }): Promise<ReviewRequest>;

  approve(params: {
    nestId: string;
    nodeId: string;
    approvedBy: string;
    note?: string;
    override?: boolean;
  }): Promise<ReviewRequest>;

  reject(params: {
    nestId: string;
    nodeId: string;
    rejectedBy: string;
    note: string;
  }): Promise<ReviewRequest>;

  cancelReview(params: {
    nestId: string;
    nodeId: string;
    cancelledBy: string;
  }): Promise<ReviewRequest | null>;

  // Queries
  getReviewQueue(params: {
    nestId?: string;
    status?: ReviewRequestStatus | ReviewRequestStatus[];
    stewardEmail?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ requests: ReviewRequest[]; total: number }>;

  getReviewHistory(
    nestId: string,
    nodeId: string,
  ): Promise<ReviewRequest[]>;

  getPendingReview(
    nestId: string,
    nodeId: string,
  ): Promise<ReviewRequest | null>;
}

/**
 * Version storage — track node versions and conflict detection.
 */
export interface VersionAdapter {
  // Create a new version when a node is updated
  createVersion(params: {
    nestId: string;
    nodeId: string;
    version: number;
    content: string;
    author: string;
    status: DocumentLifecycleStatus;
    changeNote?: string;
  }): Promise<DocumentVersion>;

  // Get all versions for a node
  getVersions(nestId: string, nodeId: string): Promise<DocumentVersion[]>;

  // Get a specific version
  getVersion(
    nestId: string,
    nodeId: string,
    version: number,
  ): Promise<DocumentVersion | null>;

  // Get the current (latest) version number
  getCurrentVersion(nestId: string, nodeId: string): Promise<number>;

  // Get the approved version number (for AI queries)
  getApprovedVersion(nestId: string, nodeId: string): Promise<number | null>;

  // Set which version is the approved one
  setApprovedVersion(
    nestId: string,
    nodeId: string,
    version: number,
  ): Promise<void>;
}

/**
 * Access control — server-level config for allowed users, groups, super admins.
 */
export interface AccessAdapter {
  // Load and cache access.yaml
  loadConfig(configPath: string): AccessConfig;

  // Check if an email is allowed to register
  isEmailAllowed(email: string): boolean;

  // Get the group(s) a user belongs to
  getGroupsForUser(email: string): string[];

  // Get the default permission for a user based on group membership
  getDefaultPermission(email: string): "read" | "write" | "admin" | null;

  // Check if a user is a super admin
  isSuperAdmin(email: string): boolean;
}

/**
 * Permission checks — convenience functions built on top of the adapters.
 * Ported from PromptOwl's canUserApproveDocument, canUserEditDocument, etc.
 */
export interface PermissionChecker {
  canApprove(
    nestId: string,
    nodeId: string,
    userEmail: string,
  ): Promise<{ allowed: boolean; reason: string }>;

  canEdit(
    nestId: string,
    nodeId: string,
    userEmail: string,
  ): Promise<{ allowed: boolean; reason: string }>;

  canAccess(
    nestId: string,
    nodeId: string,
    userEmail: string,
  ): Promise<{
    allowed: boolean;
    role: "owner" | "editor" | "reviewer" | "viewer" | null;
    reason: string;
  }>;
}
