export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
}

export type NestVisibility = "private" | "org" | "public";

export interface Nest {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  description: string | null;
  /**
   * 'org' = every authenticated user of this deployment (Community has no
   * tenant model; a self-hosted install is one organization). Kept in sync
   * with the CHECK in migrations.ts and with NestVisibility in ui/src/lib/api.ts.
   */
  visibility: NestVisibility;
  created_at: string;
  // 1 when the nest was imported from an existing folder (its files copied
  // into <DATA_ROOT>/nests/<id>); drives the "Imported" badge and flat
  // discovery. 0 for default nests.
  is_imported: number;
  // 1 when draft-first + approval workflow is enabled. Read straight off the
  // row by the dashboard annotate() path, so keep it on the type — a query
  // that narrowed its columns would otherwise report every nest ungoverned
  // with no compiler warning.
  stewardship_enabled: number;
  // 1 when Public Docs Reader Mode is on — a superadmin-enabled, read-only
  // public docs view. Read straight off the SELECT * row (getNest) so it
  // surfaces on GET /nests/:id and drives the reader presentation.
  reader_mode?: number;
  // Designated reader-mode landing/hub node id; null resolves by convention.
  reader_home_node?: string | null;
  // Per-nest reader branding, stored as validated JSON (src/shared/branding.ts).
  // Never sent to clients raw — GET /nests/:id replaces it with a parsed
  // `branding` object.
  branding_json?: string | null;
  // When set, the nest is archived: hidden from every listing that isn't
  // explicitly asking for archived nests, invisible to MCP, and read-only
  // (see resolveNestAccess). null/undefined = a live nest.
  archived_at?: string | null;
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
  /**
   * Where the team came from — 'promptowl' for an imported team, null for one
   * created here. Drives the "imported" badge and the re-sync affordance.
   */
  source?: string | null;
  /**
   * The team's id in `source`'s system. Together with owner_id + source this is
   * the import key: it's what makes a re-import update this row rather than
   * create a second copy, and it survives a rename on either side.
   */
  external_id?: string | null;
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
