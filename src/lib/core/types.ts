/**
 * Shared governance types — the universally-compatible subset.
 *
 * These types are byte-identical between contextnest-community and TheOwl
 * today. The intentionally-excluded drift items (StewardshipScope,
 * DocumentLifecycleStatus, Steward/ContextSteward) stay per-repo until a
 * future alignment ADR decides the schema migration.
 *
 * Source of truth: this file. Both repos re-export from here.
 */

export type StewardRole = "editor" | "reviewer" | "viewer";

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
