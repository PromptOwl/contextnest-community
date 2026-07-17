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
  // 012 merges case-colliding SQLite user rows. Postgres can never have them:
  // the NOCASE-unique idx_users_email_nocase (lower(email)) exists from table
  // creation, so duplicates are rejected on insert and there's nothing to merge.
  // Seed the id so bookkeeping matches SQLite and future incremental Postgres
  // migrations gate correctly.
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
        CHECK(visibility IN ('private', 'public')),
      created_at TEXT NOT NULL DEFAULT ${NOW},
      stewardship_enabled INTEGER NOT NULL DEFAULT 0,
      is_imported INTEGER NOT NULL DEFAULT 0,
      allow_self_approve INTEGER NOT NULL DEFAULT 0,
      shared_teams TEXT NOT NULL DEFAULT '[]',
      UNIQUE(user_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_nests_user ON nests(user_id);

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
    -- One api_key row per user (migration 003).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_unique ON api_keys(user_id);

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
      validated_at TEXT NOT NULL DEFAULT ${NOW}
    );

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
      created_at TEXT NOT NULL DEFAULT ${NOW},
      UNIQUE(nest_id, node_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_versions_node ON node_versions(nest_id, node_id);

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

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      members TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW}
    );
    CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_id);

    -- nests.shared_teams is declared inline in the CREATE TABLE above, which is
    -- a no-op on any database created before teams shipped. Every nest
    -- permission check reads this column, so without the explicit ALTER an
    -- existing deployment breaks on upgrade, not just the Teams feature.
    ALTER TABLE nests ADD COLUMN IF NOT EXISTS shared_teams TEXT NOT NULL DEFAULT '[]';

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
      PRIMARY KEY (nest_id, node_id)
    );
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
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_events_ts ON api_events(ts);
    -- (nest_id, id) composite (migration 026): the per-nest trace view
    -- (GET /nests/:id/trace) filters by nest_id and pages newest-first by id.
    CREATE INDEX IF NOT EXISTS idx_api_events_nest_ts ON api_events(nest_id, id);

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

  // Migration 005 parity: anon-owned nests default to public visibility.
  await db.run(
    "UPDATE nests SET visibility = 'public' WHERE user_id = ? AND visibility = 'private'",
    [ANON_USER_ID],
  );
}
