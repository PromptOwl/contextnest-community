export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
}

export interface Nest {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: "private" | "public";
  created_at: string;
  // 1 when the nest was imported from an existing folder (its files copied
  // into <DATA_ROOT>/nests/<id>); drives the "Imported" badge and flat
  // discovery. 0 for default nests.
  is_imported: number;
}

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  nest_id: string | null;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

export type NestCollaboratorPermission = "read" | "write" | "admin";

export interface NestCollaborator {
  id: string;
  nest_id: string;
  user_id: string;
  permission: NestCollaboratorPermission;
  granted_by: string;
  granted_at: string;
}

/**
 * A team member's role. Same vocabulary as EffectiveRole minus 'owner'
 * (a team has an owner_id, not an owner member). Set per-member and applied
 * uniformly on every nest the team is shared to.
 */
export type TeamMemberRole = "admin" | "editor" | "viewer";

export interface TeamMember {
  userId: string;
  email: string;
  role: TeamMemberRole;
  /**
   * True when the member has a real registered account; false when they are an
   * invited placeholder (is_invited = 1) who hasn't claimed the email yet.
   * Populated on read (enrichment), absent in the stored JSON.
   */
  registered?: boolean;
}

/** A team — a reusable, owner-managed group with an inline member roster. */
export interface Team {
  id: string;
  name: string;
  owner_id: string;
  /** Owner's email, resolved on read for display ("Created by …"). */
  owner_email?: string;
  members: TeamMember[];
  created_at: string;
  updated_at: string;
}

/**
 * Entry in `nests.shared_teams` — a team shared onto a nest. `teamId` is
 * canonical; `teamName` is a cached display label refreshed on team rename.
 */
export interface SharedTeamRef {
  teamId: string;
  teamName: string;
}
