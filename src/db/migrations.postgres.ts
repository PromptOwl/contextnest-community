import type { DatabaseAdapter } from "./adapter.js";
import { ANON_USER_ID } from "../shared/constants.js";

/**
 * PostgreSQL schema — the CONSOLIDATED END STATE of the SQLite migration
 * chain in `migrations.ts` (after migrations 002–011 have all been applied).
 *
 * Postgres deployments are greenfield (there is never pre-existing Postgres
 * data to migrate), so instead of replaying SQLite's incremental + table
 * rebuild migrations we declare each table directly in its final shape. This
 * is far less error-prone than translating the SQLite table-rebuild dances.
 *
 * Differences from the SQLite DDL, applied here once:
 *   - `INTEGER PRIMARY KEY AUTOINCREMENT`  → `bigint generated always as identity`
 *   - `datetime('now')` text defaults      → `to_char((now() AT TIME ZONE 'utc'),
 *                                              'YYYY-MM-DD HH24:MI:SS')` so values
 *                                              are byte-identical to SQLite
 *   - booleans stay `integer` (0/1)         so existing `? 1 : 0` writes round-trip
 *   - `users.email` case-insensitive uniq   → unique index on `lower(email)`
 *   - JSON columns stay `text`              (parsed/serialised in JS, as today)
 *
 * Everything is `IF NOT EXISTS` so re-running on an existing Postgres database
 * is a no-op.
 */

// SQLite `datetime('now')` → 'YYYY-MM-DD HH:MM:SS' (UTC). Match it exactly.
const NOW = "to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')";

// Historical SQLite migration ids — seeded as already-applied so any FUTURE
// incremental Postgres migration can reuse the same hasMigration/recordMigration
// gating without re-running schema that's already baked into the DDL below.
const HISTORICAL_MIGRATIONS = [
  "002_steward_parity",
  "003_sessions_and_single_api_key",
  "004_license_cache_owner_email",
  "005_anon_nest_public_default",
  "006_node_versions_published_status",
  "007_drop_steward_capability_flags",
  "008_drop_steward_folder_scope",
  "009_lowercase_emails",
  "010_sso_used_jti",
  "011_comments",
  "012_merge_case_colliding_users",
  "013_node_deletion_tombstones",
  "014_api_events",
  "015_definitions",
  "016_workflow_edges",
  "017_workflow_runs",
  "018_subagent_runs",
  "019_grants",
  "020_schedules",
  "021_schedule_bounds",
  "022_tools_and_watchers",
  "023_connectors",
  "024_trigger_hooks",
  "025_run_claims",
  "020_server_settings",
  "026_api_events_nest_index",
  "027_teams",
  "028_user_department",
  "029_super_admins",
  "031_team_source",
  "032_deletion_requests",
  "033_deletion_request_targets",
  "034_versions_author_status_index",
  "035_multiple_api_keys_per_user",
  "036_node_index",
  "037_publish",
  "038_nest_archive",
  "039_nest_pins",
  "040_push_confirmation",
  "041_nest_visibility_org",
  "042_community_sites",
  "043_node_suggestion_details",
  "044_client_attribution",
  "045_headless_publish",
  "046_deletion_client_attribution",
  "047_node_access_events",
  "048_license_cache_features",
  "049_license_cache_gateway",
  "050_agent_read_log",
  "051_boards",
  "052_nest_done_tags",
  "053_license_cache_own_gateway",
  "054_metacognition_agents",
  "055_access_requests",
];

export async function runPostgresMigrations(db: DatabaseAdapter): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_invited INTEGER NOT NULL DEFAULT 0,
      department TEXT
    );
    -- Case-insensitive email uniqueness (replaces SQLite COLLATE NOCASE index).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users (lower(email));
    -- users.department is declared inline above (no-op for databases created
    -- before it shipped) — migration 028 parity for existing deployments.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;

    CREATE TABLE IF NOT EXISTS nests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
        CHECK(visibility IN ('private', 'org', 'public')),
      created_at TEXT NOT NULL DEFAULT ${NOW},
      stewardship_enabled INTEGER NOT NULL DEFAULT 0,
      is_imported INTEGER NOT NULL DEFAULT 0,
      allow_self_approve INTEGER NOT NULL DEFAULT 0,
      prime_only_review INTEGER NOT NULL DEFAULT 0,
      prime_tags TEXT NOT NULL DEFAULT 'prime-document',
      creator_is_reviewer INTEGER NOT NULL DEFAULT 0,
      shared_teams TEXT NOT NULL DEFAULT '[]',
      index_synced_at TEXT,
      require_push_confirmation INTEGER NOT NULL DEFAULT 0,
      reader_mode INTEGER NOT NULL DEFAULT 0,
      reader_home_node TEXT,
      -- Per-nest reader branding JSON (CU-wdqcq02ptm); NULL = unbranded.
      branding_json TEXT,
      -- Set = archived (migration 038): off the dashboard, out of MCP, read
      -- only, nothing deleted. NULL is the whole "not archived" story.
      archived_at TEXT,
      UNIQUE(user_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_nests_user ON nests(user_id);
    -- Push Confirmation Gate (migration 040): declared inline above; explicit
    -- ALTER for databases created before it shipped.
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS require_push_confirmation INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      key_hash TEXT UNIQUE NOT NULL,
      key_prefix TEXT NOT NULL,
      nest_id TEXT REFERENCES nests(id) ON DELETE CASCADE,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_keys_hash ON api_keys(key_hash);
    -- Migration 003 capped this at one row per user; 035 lifted it so a user
    -- can hold one key per place they connect from and rotate them singly.
    DROP INDEX IF EXISTS idx_api_keys_user_unique;

    CREATE TABLE IF NOT EXISTS nest_collaborators (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL CHECK(permission IN ('read', 'write', 'admin')),
      granted_by TEXT NOT NULL REFERENCES users(id),
      granted_at TEXT NOT NULL DEFAULT ${NOW}
    );
    CREATE INDEX IF NOT EXISTS idx_nest_collab_nest ON nest_collaborators(nest_id);
    CREATE INDEX IF NOT EXISTS idx_nest_collab_user ON nest_collaborators(user_id);

    CREATE TABLE IF NOT EXISTS annotation_threads (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      snapshot_version INTEGER,
      anchor_json TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'resolved')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      resolved_by TEXT,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS annotation_comments (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES annotation_threads(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );
    CREATE INDEX IF NOT EXISTS idx_annot_threads_node
      ON annotation_threads(nest_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_annot_comments_thread
      ON annotation_comments(thread_id);

    CREATE TABLE IF NOT EXISTS license_cache (
      key TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      org TEXT,
      limits_json TEXT,
      owner_email TEXT,
      gateway_json TEXT,           -- license's LiteLLM key, encrypted (migration 049)
      validated_at TEXT NOT NULL DEFAULT ${NOW}
    );
    ALTER TABLE license_cache ADD COLUMN IF NOT EXISTS features_json TEXT;
    ALTER TABLE license_cache ADD COLUMN IF NOT EXISTS gateway_json TEXT;
    ALTER TABLE license_cache ADD COLUMN IF NOT EXISTS own_gateway_json TEXT; -- own-provider key (migration 053)

    CREATE TABLE IF NOT EXISTS telemetry_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      sent INTEGER NOT NULL DEFAULT 0
    );

    -- Stewards in final shape (after migrations 002/007/008):
    -- role IN (editor|reviewer|viewer); no can_approve/can_reject; no folder scope.
    CREATE TABLE IF NOT EXISTS stewards (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK(scope IN ('document', 'tag', 'nest')),
      node_pattern TEXT,
      tag_name TEXT,
      user_email TEXT NOT NULL,
      user_id TEXT REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'reviewer'
        CHECK(role IN ('editor', 'reviewer', 'viewer')),
      assigned_by TEXT NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT ${NOW},
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_stewards_nest ON stewards(nest_id);
    CREATE INDEX IF NOT EXISTS idx_stewards_email ON stewards(user_email);
    CREATE INDEX IF NOT EXISTS idx_stewards_scope ON stewards(nest_id, scope);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stewards_uniq_nest
      ON stewards(nest_id, user_email)
      WHERE scope = 'nest' AND is_active = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stewards_uniq_document
      ON stewards(nest_id, node_pattern, user_email)
      WHERE scope = 'document' AND node_pattern IS NOT NULL AND is_active = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stewards_uniq_tag
      ON stewards(nest_id, tag_name, user_email)
      WHERE scope = 'tag' AND tag_name IS NOT NULL AND is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_stewards_tag_lookup
      ON stewards(nest_id, tag_name)
      WHERE scope = 'tag' AND is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_stewards_doc_lookup
      ON stewards(nest_id, node_pattern)
      WHERE scope = 'document' AND is_active = 1;

    CREATE TABLE IF NOT EXISTS review_requests (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL DEFAULT ${NOW},
      request_note TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
      resolved_by TEXT,
      resolved_at TEXT,
      resolution_note TEXT,
      is_override INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK(priority IN ('low', 'normal', 'high', 'urgent'))
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_nest ON review_requests(nest_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_node ON review_requests(nest_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_status ON review_requests(nest_id, status);

    -- node_versions in final shape (after migration 006: 'published' status).
    CREATE TABLE IF NOT EXISTS node_versions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      author TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft', 'pending_review', 'approved', 'published', 'rejected')),
      change_note TEXT,
      tags_json TEXT,
      -- Caller attribution (spec §9.4, migration 044): which agent/session made
      -- the write that sealed this version. Annotation only — never hashed,
      -- never authorized from, NULL when the call carried none.
      client_json TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      UNIQUE(nest_id, node_id, version)
    );
    ALTER TABLE node_versions ADD COLUMN IF NOT EXISTS client_json TEXT;
    CREATE INDEX IF NOT EXISTS idx_versions_node ON node_versions(nest_id, node_id);
    -- Migration 034 (SQLite): the /me/drafts lookup — author + status.
    CREATE INDEX IF NOT EXISTS idx_versions_author_status
      ON node_versions(author, status);

    CREATE TABLE IF NOT EXISTS approved_versions (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      approved_version INTEGER NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL DEFAULT ${NOW},
      PRIMARY KEY (nest_id, node_id)
    );

    -- node_tag_index (migration 002).
    CREATE TABLE IF NOT EXISTS node_tag_index (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      tag_name TEXT NOT NULL,
      PRIMARY KEY (nest_id, node_id, tag_name)
    );
    CREATE INDEX IF NOT EXISTS idx_node_tag_by_tag
      ON node_tag_index(nest_id, tag_name);

    -- node_index (migration 036). Derived mirror of the on-disk document set,
    -- so listings answer from SQL instead of walking the vault.
    CREATE TABLE IF NOT EXISTS node_index (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'document',
      status TEXT NOT NULL DEFAULT 'draft',
      updated_at TEXT,
      frontmatter_json TEXT NOT NULL,
      PRIMARY KEY (nest_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_node_index_folder
      ON node_index(nest_id, folder);

    -- node_suggestions (migrations 036 + 043). One row per staged external
    -- edit with the suggestion itself — so the External Edits list and its
    -- badge are a SELECT, not a vault walk, and old vs new is detected_at.
    CREATE TABLE IF NOT EXISTS node_suggestions (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      suggestion_id TEXT NOT NULL,
      source TEXT NOT NULL,
      actor TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      proposed_hash TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      PRIMARY KEY (nest_id, node_id, suggestion_id)
    );
    -- idx_node_suggestions_nest_detected is created after the 043 parity
    -- check below: a pre-043 database already has node_suggestions without
    -- detected_at, so CREATE TABLE IF NOT EXISTS is a no-op and indexing the
    -- column here aborts the whole bootstrap before the rebuild can run.

    -- sessions (migration 003).
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      last_seen_at TEXT NOT NULL DEFAULT ${NOW},
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    -- sso_used_jti (migration 010).
    CREATE TABLE IF NOT EXISTS sso_used_jti (
      jti TEXT PRIMARY KEY,
      used_at TEXT NOT NULL DEFAULT ${NOW},
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sso_used_jti_expires
      ON sso_used_jti(expires_at);

    -- comments (migration 011).
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      version INTEGER,
      anchor_start INTEGER,
      anchor_end INTEGER,
      anchor_text TEXT,
      parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'resolved')),
      created_at TEXT NOT NULL DEFAULT ${NOW},
      resolved_by TEXT,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_comments_node
      ON comments(nest_id, node_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_comments_open
      ON comments(nest_id, node_id, status);
    CREATE INDEX IF NOT EXISTS idx_comments_thread
      ON comments(parent_id);

    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK(target_type IN ('document', 'folder')),
      target TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('read', 'write')),
      granted_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_unique
      ON grants(nest_id, target_type, target, user_id);
    CREATE INDEX IF NOT EXISTS idx_grants_user ON grants(nest_id, user_id);

    CREATE TABLE IF NOT EXISTS publish (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      access_mode TEXT NOT NULL DEFAULT 'public'
        CHECK(access_mode IN ('public','email','code','invite')),
      code_hash TEXT,
      comments_enabled INTEGER NOT NULL DEFAULT 0,
      watermark INTEGER NOT NULL DEFAULT 0,
      no_download INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_slug ON publish(slug);
    CREATE INDEX IF NOT EXISTS idx_publish_nest ON publish(nest_id, node_id);

    CREATE TABLE IF NOT EXISTS access_grant (
      id TEXT PRIMARY KEY,
      publish_id TEXT NOT NULL REFERENCES publish(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('invite','link','session','view')),
      email TEXT,
      token_hash TEXT,
      expires_at TEXT,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_access_grant_publish ON access_grant(publish_id, kind);
    CREATE INDEX IF NOT EXISTS idx_access_grant_token ON access_grant(token_hash);

    -- Viewer overlays, declared inline above; explicit ALTERs so a database
    -- created by an earlier build of 037 still gets them on upgrade.
    ALTER TABLE publish ADD COLUMN IF NOT EXISTS watermark INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE publish ADD COLUMN IF NOT EXISTS no_download INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      members TEXT NOT NULL DEFAULT '[]',
      source TEXT,
      external_id TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );
    CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_id);

    -- teams.source / teams.external_id are declared inline above, which is a
    -- no-op on any database created before imported teams shipped — hence the
    -- explicit ALTERs (migration 031 parity). The partial unique index is what
    -- makes a re-import update its own row rather than duplicate it; NULL
    -- external_id (every hand-made team) is excluded so those never collide.
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS source TEXT;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS external_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_external
      ON teams(owner_id, source, external_id)
      WHERE external_id IS NOT NULL;

    -- nests.shared_teams is declared inline in the CREATE TABLE above, which is
    -- a no-op on any database created before teams shipped. Every nest
    -- permission check reads this column, so without the explicit ALTER an
    -- existing deployment breaks on upgrade, not just the Teams feature.
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS shared_teams TEXT NOT NULL DEFAULT '[]';

    -- Prime documents: same inline-plus-explicit-ALTER pattern, so a database
    -- created before prime shipped still gets the columns on upgrade.
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS prime_only_review INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS prime_tags TEXT NOT NULL DEFAULT 'prime-document';
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS creator_is_reviewer INTEGER NOT NULL DEFAULT 0;

    -- node_index freshness stamp: same inline-plus-explicit-ALTER pattern. The
    -- inline declaration only reaches a database created after it shipped, and
    -- EVERY listing reads this column to decide whether to rebuild — so on an
    -- existing deployment its absence is not a degraded index, it is a 500 on
    -- the document list. NULL is the correct starting value: it means "rebuild
    -- from disk before answering", which is exactly right for a nest whose
    -- index has never been built.
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS index_synced_at TEXT;

    -- Public Docs Reader Mode: same inline-plus-explicit-ALTER pattern so a
    -- database created before reader mode shipped still gets the columns on
    -- upgrade. reader_mode is off by default; reader_home_node is nullable.
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS reader_mode INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS reader_home_node TEXT;
    -- Per-nest reader branding (CU-wdqcq02ptm): same inline-plus-ALTER pattern.
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS branding_json TEXT;
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS archived_at TEXT;

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      agent_node TEXT NOT NULL,
      every_minutes INTEGER NOT NULL CHECK(every_minutes >= 5),
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      max_runs INTEGER,
      runs_created INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_agent
      ON schedules(nest_id, agent_node);

    CREATE TABLE IF NOT EXISTS nest_env (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (nest_id, key)
    );
    CREATE TABLE IF NOT EXISTS watchers (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watchers_unique
      ON watchers(nest_id, node_id, user_email);
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      user_email TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject_id TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user
      ON notifications(user_email, read_at, created_at);

    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK(channel IN ('slack', 'teams', 'webhook')),
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_connectors_nest ON connectors(nest_id);

    CREATE TABLE IF NOT EXISTS trigger_hooks (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      agent_node TEXT NOT NULL,
      preset TEXT NOT NULL CHECK(preset IN ('slack', 'teams', 'webhook')),
      enabled INTEGER NOT NULL DEFAULT 1,
      fire_count INTEGER NOT NULL DEFAULT 0,
      last_fired_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hooks_nest ON trigger_hooks(nest_id);

    CREATE TABLE IF NOT EXISTS edge_types (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'directed'
        CHECK(direction IN ('directed', 'undirected')),
      is_flow INTEGER NOT NULL DEFAULT 0,
      condition_schema TEXT,
      color TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_types_name
      ON edge_types(nest_id, LOWER(name));

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      from_node TEXT NOT NULL,
      to_node TEXT NOT NULL,
      -- RESTRICT (not CASCADE): the app refuses to delete an edge type while
      -- edges reference it; the DB backs that invariant instead of silently
      -- cascade-deleting live edges if the app check is bypassed. Keep in
      -- lockstep with migrations.ts.
      type_id TEXT NOT NULL REFERENCES edge_types(id) ON DELETE RESTRICT,
      condition_mode TEXT
        CHECK(condition_mode IN ('structured', 'nl', 'open')),
      condition TEXT,
      metadata TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(nest_id, from_node);
    CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(nest_id, to_node);
    CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(nest_id, type_id);

    CREATE TABLE IF NOT EXISTS definitions (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      term TEXT NOT NULL,
      definition TEXT NOT NULL,
      linked_tag TEXT,
      defined_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- Case-insensitive uniqueness the portable way (SQLite side uses
    -- COLLATE NOCASE; Postgres has no NOCASE collation).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_definitions_term
      ON definitions(nest_id, LOWER(term));

    -- node_deletions tombstones (migration 013). DELETE /nodes purges all other
    -- governance rows for the node; this is the only record that a doc was
    -- removed, read by GET /nests/:id/changes. One row per (nest, node); a
    -- re-delete after recreate upserts in place. deleted_at written explicitly.
    CREATE TABLE IF NOT EXISTS node_deletions (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT NOT NULL,
      client_json TEXT,            -- caller attribution (migration 046)
      PRIMARY KEY (nest_id, node_id)
    );
    ALTER TABLE node_deletions ADD COLUMN IF NOT EXISTS client_json TEXT;
    CREATE INDEX IF NOT EXISTS idx_node_deletions_time
      ON node_deletions(nest_id, deleted_at);

    -- activity trace (migration 014). One row per API request / MCP tool call
    -- so the server admin has a single place to audit everything. Pruned on a
    -- rolling window in trace-log.ts.
    CREATE TABLE IF NOT EXISTS api_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('api', 'mcp')),
      method TEXT,                 -- HTTP method (api rows)
      path TEXT,                   -- request path (api rows)
      tool TEXT,                   -- tool name (mcp rows)
      nest_id TEXT,
      user_id TEXT,
      user_email TEXT,
      status INTEGER,              -- HTTP status (api + mcp rows)
      duration_ms INTEGER,
      client_json TEXT             -- caller attribution (§9.4, migration 044)
    );
    ALTER TABLE api_events ADD COLUMN IF NOT EXISTS client_json TEXT;
    CREATE INDEX IF NOT EXISTS idx_api_events_ts ON api_events(ts);
    -- (nest_id, id) composite (migration 026): the per-nest trace view
    -- (GET /nests/:id/trace) filters by nest_id and pages newest-first by id.
    CREATE INDEX IF NOT EXISTS idx_api_events_nest_ts ON api_events(nest_id, id);

    -- document access events (migration 047): reads, retrievals and exports,
    -- which seal no version. node_id NULL = whole-nest export. Throttled and
    -- pruned in governance/access-log.ts.
    CREATE TABLE IF NOT EXISTS node_access_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ts TEXT NOT NULL,
      nest_id TEXT NOT NULL,
      node_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('read', 'retrieve', 'export')),
      surface TEXT NOT NULL CHECK(surface IN ('api', 'mcp')),
      user_id TEXT,
      user_email TEXT,
      client_json TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_node_access_node ON node_access_events(nest_id, node_id, id);
    CREATE INDEX IF NOT EXISTS idx_node_access_nest ON node_access_events(nest_id, id);
    CREATE INDEX IF NOT EXISTS idx_node_access_ts ON node_access_events(ts);
    -- migration 050: the version the read was served, and the agent that
    -- made it (client.agent split out so per-agent queries are indexed).
    ALTER TABLE node_access_events ADD COLUMN IF NOT EXISTS version INTEGER;
    ALTER TABLE node_access_events ADD COLUMN IF NOT EXISTS agent TEXT;
    CREATE INDEX IF NOT EXISTS idx_node_access_agent ON node_access_events(nest_id, agent, id);

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      agent_node TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running', 'succeeded', 'failed', 'cancelled')),
      inputs TEXT,
      trace TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      claimed_by TEXT,
      claimed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_nest ON runs(nest_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(nest_id, agent_node);

    CREATE TABLE IF NOT EXISTS run_steps (
      id SERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      node_id TEXT,
      edge_id TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_steps ON run_steps(run_id, seq);
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS parent_run_id TEXT;
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0;
    -- migration 025 parity: runs tables created before the claim columns.
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS claimed_by TEXT;
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS claimed_at TEXT;
    CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);

    -- server_settings (migration 020): durable store for runtime-mutable server
    -- config (admin Settings + installed license key), loaded into process.env
    -- at boot. Replaces the ephemeral .env-file persistence. value NULL is a
    -- tombstone (explicitly cleared); env_at_write is the deploy-env baseline
    -- for reconcile precedence — see db/settings.ts.
    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      env_at_write TEXT,
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );

    -- super_admins (migration 028): DB-backed superadmin grants made from the
    -- UI/API. Effective superadmin = access.yaml super_admins ∪ these rows
    -- (case-insensitive; emails stored lowercased). File entries can never be
    -- revoked via the API — lockout safety.
    CREATE TABLE IF NOT EXISTS super_admins (
      email TEXT PRIMARY KEY,
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL DEFAULT ${NOW}
    );

    -- deletion requests (migration 032). A user below write tier flags a stale
    -- node with a reason; a writer either deletes it (which purges this row with
    -- the node's others) or declines with a note. Separate from review_requests
    -- on purpose — a flagged node is not under review.
    CREATE TABLE IF NOT EXISTS deletion_requests (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      -- target: a node id, a folder path ("api/limits"), or the nest id —
      -- which one is told by target_type (migration 033).
      node_id TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'document',
      requested_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'declined')),
      created_at TEXT NOT NULL DEFAULT ${NOW},
      resolved_by TEXT,
      resolved_at TEXT,
      resolution_note TEXT
    );
    ALTER TABLE deletion_requests
      ADD COLUMN IF NOT EXISTS target_type TEXT NOT NULL DEFAULT 'document';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deletion_requests_pending
      ON deletion_requests(nest_id, target_type, node_id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_deletion_requests_nest
      ON deletion_requests(nest_id, status);

    -- Pinned nests (migration 039). Per PERSON per nest, not a property of the
    -- nest: two people sharing one nest pin different things. The composite key
    -- is the whole uniqueness rule; the nest FK cascades.
    CREATE TABLE IF NOT EXISTS nest_pins (
      -- Both sides cascade, as grants and nest_collaborators do: without it on
      -- user_id, deleting an account holding a single pin fails on the FK.
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      PRIMARY KEY (user_id, nest_id)
    );
    CREATE INDEX IF NOT EXISTS idx_nest_pins_user ON nest_pins(user_id);

    -- Push Confirmation Gate (migration 040). pending_pushes holds a gated agent
    -- push in full (payload_blob) until a reviewer confirms; push_allowlist is
    -- PER-API-KEY (key_id '' = any of that user's keys), never keyed on nest
    -- alone. SQLite parity in migrations.ts 040_push_confirmation.
    CREATE TABLE IF NOT EXISTS pending_pushes (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      submitter_user_id TEXT NOT NULL,
      submitter_key_id TEXT,
      submitter_label TEXT,
      submitter_email TEXT,
      doc_count INTEGER NOT NULL DEFAULT 0,
      manifest_json TEXT NOT NULL DEFAULT '[]',
      payload_blob TEXT NOT NULL,
      context_md TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'applied', 'rejected', 'expired')),
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by_user_id TEXT,
      applied_node_count INTEGER,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_pushes_nest_status
      ON pending_pushes(nest_id, status, created_at);

    CREATE TABLE IF NOT EXISTS push_allowlist (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      key_id TEXT NOT NULL DEFAULT '',
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (nest_id, user_id, key_id)
    );

    -- community_sites (migration 042): official community site connections
    -- trusted for SSO auto-login — extends the single OFFICIAL_COMMUNITY_SSO_
    -- SECRET/PUBLIC_BASE_URL env-var pair to a DB-backed list, each row with
    -- its own name/url/secret and an active flag. See src/auth/community-sites.ts.
    CREATE TABLE IF NOT EXISTS community_sites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      secret TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT ${NOW}
    );
  `);

  // Seed historical migration ids as already-applied (idempotent).
  for (const id of HISTORICAL_MIGRATIONS) {
    await db.run(
      "INSERT INTO schema_migrations (id) VALUES (?) ON CONFLICT DO NOTHING",
      [id],
    );
  }

  // Migration 041 parity: widen the visibility CHECK to accept 'org' on a
  // database created before it existed. Postgres has no ADD CONSTRAINT IF NOT
  // EXISTS, so this is a drop-then-add by the constraint's generated name.
  //
  // Read the current definition first rather than swapping unconditionally:
  // ADD CONSTRAINT re-validates every existing row and takes a lock to do it,
  // so an unguarded swap would pay that cost on every server start and grow
  // with the table. Every other statement in this file is a true no-op on an
  // up-to-date database (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS); this one
  // has to be as well.
  //
  // Unlike SQLite this is catalogue-only — no table rebuild, so none of the
  // ON DELETE CASCADE hazard that makes the SQLite side delicate.
  const visibilityCheck = (await db.get(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'nests'::regclass
        AND conname = 'nests_visibility_check'`,
  )) as { def?: string } | undefined;
  if (!visibilityCheck?.def?.includes("'org'")) {
    await db.run(
      "ALTER TABLE nests DROP CONSTRAINT IF EXISTS nests_visibility_check",
    );
    await db.run(
      "ALTER TABLE nests ADD CONSTRAINT nests_visibility_check CHECK (visibility IN ('private', 'org', 'public'))",
    );
  }

  // Migration 043 parity: a database from before 043 has the flag-only
  // node_suggestions (no suggestion_id). Rebuild it empty and mark every nest
  // stale so the next index rebuild re-fills it from disk. Guarded on the
  // column so an up-to-date database pays nothing.
  const suggestionIdCol = (await db.get(
    `SELECT 1 AS ok FROM information_schema.columns
      WHERE table_name = 'node_suggestions' AND column_name = 'suggestion_id'`,
  )) as { ok?: number } | undefined;
  if (!suggestionIdCol?.ok) {
    await db.exec(`
      DROP TABLE IF EXISTS node_suggestions;
      CREATE TABLE node_suggestions (
        nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        suggestion_id TEXT NOT NULL,
        source TEXT NOT NULL,
        actor TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        proposed_hash TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT ${NOW},
        PRIMARY KEY (nest_id, node_id, suggestion_id)
      );
      UPDATE nests SET index_synced_at = NULL;
    `);
  }
  // Both shapes (fresh bootstrap and the rebuild above) now carry detected_at.
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_node_suggestions_nest_detected
      ON node_suggestions(nest_id, detected_at DESC);
  `);

  // Migration 045 parity: headless publishing (CU-wdqcq0314u).
  await db.exec(`
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS headless INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_service INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS headless_readers (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      key_id TEXT NOT NULL,
      label TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW}
    );
    CREATE INDEX IF NOT EXISTS idx_headless_readers_nest ON headless_readers(nest_id);
  `);

  // Migration 050 parity: read logging is on for every nest unless an owner
  // turns it off.
  await db.exec(`
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS access_log_enabled INTEGER NOT NULL DEFAULT 1;
  `);

  // Migration 051 parity: saved Board views.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      private INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );
    CREATE INDEX IF NOT EXISTS idx_boards_nest ON boards(nest_id, position);
  `);

  // Migration 052 parity: which column tags mean "completed".
  await db.exec(
    "ALTER TABLE nests ADD COLUMN IF NOT EXISTS done_tags TEXT NOT NULL DEFAULT 'done'",
  );

  // Migration 055 parity: access requests (see migrations.ts).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS access_requests (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('node', 'folder', 'nest')),
      target_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'write' CHECK(level IN ('read', 'write')),
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'approved', 'denied')),
      created_at TEXT NOT NULL DEFAULT ${NOW},
      resolved_by TEXT,
      resolved_at TEXT,
      resolution_note TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_access_requests_pending
      ON access_requests(nest_id, requester_id, target_type, target_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_access_requests_nest
      ON access_requests(nest_id, status);
  `);

  // Migration 054 parity: metacognition agents.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS metacognition_agents (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      persona_user_id TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      PRIMARY KEY (nest_id, node_id)
    );
    -- One running server-executed run per agent, enforced atomically.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_server_run
        ON runs(nest_id, agent_node) WHERE status = 'running' AND claimed_by = 'server:metacognition';
  `);

  // Migration 005 parity: anon-owned nests default to public visibility.
  await db.run(
    "UPDATE nests SET visibility = 'public' WHERE user_id = ? AND visibility = 'private'",
    [ANON_USER_ID],
  );
}
