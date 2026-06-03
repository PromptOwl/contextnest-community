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
