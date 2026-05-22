import type Database from "better-sqlite3";
import { ANON_USER_ID } from "../shared/constants.js";

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS nests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
        CHECK(visibility IN ('private', 'public')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, slug)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      key_hash TEXT UNIQUE NOT NULL,
      key_prefix TEXT NOT NULL,
      nest_id TEXT REFERENCES nests(id) ON DELETE CASCADE,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_nests_user ON nests(user_id);
    CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_keys_hash ON api_keys(key_hash);

    CREATE TABLE IF NOT EXISTS nest_collaborators (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL CHECK(permission IN ('read', 'write', 'admin')),
      granted_by TEXT NOT NULL REFERENCES users(id),
      granted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_nest_collab_nest ON nest_collaborators(nest_id);
    CREATE INDEX IF NOT EXISTS idx_nest_collab_user ON nest_collaborators(user_id);

    -- License validation cache
    CREATE TABLE IF NOT EXISTS license_cache (
      key TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      org TEXT,
      limits_json TEXT,
      validated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Telemetry event log (batched and sent to PromptOwl)
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent INTEGER NOT NULL DEFAULT 0
    );
  `);

  // ─── Governance tables (ported from PromptOwl models) ───

  db.exec(`
    -- Steward assignments (mirrors PromptOwl ContextSteward model)
    -- scope+target combination determines what the steward governs
    -- Resolution priority: document(1) > tag(2) > nest(3)
    CREATE TABLE IF NOT EXISTS stewards (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK(scope IN ('document', 'tag', 'nest')),
      node_pattern TEXT,           -- exact node id for document scope
      tag_name TEXT,               -- for tag scope
      user_email TEXT NOT NULL,
      user_id TEXT REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'reviewer'
        CHECK(role IN ('editor', 'reviewer', 'admin')),
      assigned_by TEXT NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_stewards_nest ON stewards(nest_id);
    CREATE INDEX IF NOT EXISTS idx_stewards_email ON stewards(user_email);
    CREATE INDEX IF NOT EXISTS idx_stewards_scope ON stewards(nest_id, scope);

    -- Review requests (mirrors PromptOwl ReviewRequest model)
    -- Only one pending review per node version (enforced in code)
    CREATE TABLE IF NOT EXISTS review_requests (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      requested_by TEXT NOT NULL,    -- email
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      request_note TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
      resolved_by TEXT,              -- email
      resolved_at TEXT,
      resolution_note TEXT,
      is_override INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK(priority IN ('low', 'normal', 'high', 'urgent'))
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_nest ON review_requests(nest_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_node ON review_requests(nest_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_status ON review_requests(nest_id, status);

    -- Node versions (tracks every edit, approved version pinning)
    -- The actual content lives on disk via NestStorage; this tracks metadata.
    CREATE TABLE IF NOT EXISTS node_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,    -- SHA-256 of content for conflict detection
      author TEXT NOT NULL,          -- email
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft', 'pending_review', 'approved', 'rejected')),
      change_note TEXT,
      tags_json TEXT,                -- JSON array of tags for steward resolution
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(nest_id, node_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_versions_node ON node_versions(nest_id, node_id);

    -- Approved version pinning (which version AI tools serve)
    CREATE TABLE IF NOT EXISTS approved_versions (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      approved_version INTEGER NOT NULL,
      approved_by TEXT NOT NULL,     -- email
      approved_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (nest_id, node_id)
    );
  `);

  // ─── Idempotent column adds (schema evolution) ───

  // Per-nest stewardship toggle (default: off — new docs auto-approved)
  const nestCols = (db.prepare("PRAGMA table_info(nests)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!nestCols.includes("stewardship_enabled")) {
    db.exec("ALTER TABLE nests ADD COLUMN stewardship_enabled INTEGER NOT NULL DEFAULT 0");
  }

  // Admin flag on users (first PromptOwl-authed user becomes the server admin)
  const userCols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!userCols.includes("is_admin")) {
    db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  }
  // Pending-claim flag — set to 1 when admin invites by email / shares
  // a nest / assigns a steward and the row was created server-side with
  // a random password. Register endpoint flips this to 0 when the real
  // user claims the email with their own password.
  if (!userCols.includes("is_invited")) {
    db.exec("ALTER TABLE users ADD COLUMN is_invited INTEGER NOT NULL DEFAULT 0");
  }

  // Defensive backfill for stewards columns. The CREATE TABLE above and
  // migration 002 below both declare can_approve / can_reject, but some
  // legacy DBs in the wild ended up with a stewards table missing these
  // columns (002 rebuild was skipped via schema_migrations while the
  // original table was an earlier shape). Guard with PRAGMA so this is
  // a no-op on clean DBs.
  const stewardCols = (
    db.prepare("PRAGMA table_info(stewards)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (stewardCols.length > 0) {
    if (!stewardCols.includes("can_approve")) {
      db.exec(
        "ALTER TABLE stewards ADD COLUMN can_approve INTEGER NOT NULL DEFAULT 1",
      );
    }
    if (!stewardCols.includes("can_reject")) {
      db.exec(
        "ALTER TABLE stewards ADD COLUMN can_reject INTEGER NOT NULL DEFAULT 1",
      );
    }
  }

  // ─── Versioned migrations ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const hasMigration = (id: string): boolean =>
    !!db
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(id);

  const recordMigration = (id: string) =>
    db
      .prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)")
      .run(id);

  // 002: PromptOwl parity — role set, tag/email normalization, node_tag_index
  if (!hasMigration("002_steward_parity")) {
    db.transaction(() => {
      // Rebuild stewards with new CHECK: role IN (editor|reviewer|viewer)
      // and add node_tag_index for SQL-joined tag resolution.
      db.exec(`
        CREATE TABLE stewards_new (
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
          assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
          is_active INTEGER NOT NULL DEFAULT 1
        );

        -- Copy rows; map legacy 'admin' role to 'reviewer', normalize tag_name + email.
        -- Legacy can_approve/can_reject columns are dropped here (role is now the sole signal).
        INSERT INTO stewards_new
          (id, nest_id, scope, node_pattern, tag_name, user_email, user_id,
           role, assigned_by, assigned_at, is_active)
        SELECT
          id, nest_id, scope, node_pattern,
          CASE
            WHEN tag_name IS NULL THEN NULL
            ELSE lower(ltrim(tag_name, '#'))
          END,
          lower(user_email),
          user_id,
          CASE role WHEN 'admin' THEN 'reviewer' ELSE role END,
          assigned_by, assigned_at, is_active
        FROM stewards;

        DROP TABLE stewards;
        ALTER TABLE stewards_new RENAME TO stewards;

        CREATE INDEX idx_stewards_nest ON stewards(nest_id);
        CREATE INDEX idx_stewards_email ON stewards(user_email);
        CREATE INDEX idx_stewards_scope ON stewards(nest_id, scope);
      `);

      // Partial unique indexes — one record per (nest, scope, target, email).
      db.exec(`
        CREATE UNIQUE INDEX idx_stewards_uniq_nest
          ON stewards(nest_id, user_email)
          WHERE scope = 'nest' AND is_active = 1;

        CREATE UNIQUE INDEX idx_stewards_uniq_document
          ON stewards(nest_id, node_pattern, user_email)
          WHERE scope = 'document' AND node_pattern IS NOT NULL AND is_active = 1;

        CREATE UNIQUE INDEX idx_stewards_uniq_tag
          ON stewards(nest_id, tag_name, user_email)
          WHERE scope = 'tag' AND tag_name IS NOT NULL AND is_active = 1;

        -- Resolution support indexes
        CREATE INDEX idx_stewards_tag_lookup
          ON stewards(nest_id, tag_name)
          WHERE scope = 'tag' AND is_active = 1;
        CREATE INDEX idx_stewards_doc_lookup
          ON stewards(nest_id, node_pattern)
          WHERE scope = 'document' AND is_active = 1;
      `);

      // Tag index — node -> tag mapping for fast SQL-joined resolution.
      db.exec(`
        CREATE TABLE IF NOT EXISTS node_tag_index (
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          tag_name TEXT NOT NULL,
          PRIMARY KEY (nest_id, node_id, tag_name)
        );
        CREATE INDEX IF NOT EXISTS idx_node_tag_by_tag
          ON node_tag_index(nest_id, tag_name);
      `);

      // Backfill node_tag_index from existing node_versions.tags_json.
      // For each (nest_id, node_id), take the most recent version's tags.
      type VersionRow = { nest_id: string; node_id: string; tags_json: string | null };
      const rows = db
        .prepare(
          `SELECT nv.nest_id, nv.node_id, nv.tags_json
           FROM node_versions nv
           JOIN (
             SELECT nest_id, node_id, MAX(version) AS v
             FROM node_versions
             GROUP BY nest_id, node_id
           ) latest
             ON latest.nest_id = nv.nest_id
            AND latest.node_id = nv.node_id
            AND latest.v = nv.version`,
        )
        .all() as VersionRow[];

      const insertTag = db.prepare(
        "INSERT OR IGNORE INTO node_tag_index (nest_id, node_id, tag_name) VALUES (?, ?, ?)",
      );
      for (const row of rows) {
        if (!row.tags_json) continue;
        let tags: unknown;
        try {
          tags = JSON.parse(row.tags_json);
        } catch {
          continue;
        }
        if (!Array.isArray(tags)) continue;
        for (const raw of tags) {
          if (typeof raw !== "string") continue;
          const norm = raw.trim().replace(/^#+/, "").toLowerCase();
          if (norm) insertTag.run(row.nest_id, row.node_id, norm);
        }
      }

      recordMigration("002_steward_parity");
    })();
  }

  // 003: Sessions + single-key-per-user.
  //
  // Switching auth model: web sessions move to httpOnly cookies (new
  // `sessions` table). api_keys collapses to AT MOST ONE row per user —
  // the user's external-client credential, shown only at generate/rotate
  // time. Browser auth never reads/writes the api_key plaintext.
  //
  // Migration steps:
  //   1. Create `sessions` table.
  //   2. Collapse historic api_keys to one row per user (keep most
  //      recently used or created). Drops dozens of accumulated rows.
  //   3. Add UNIQUE index on api_keys.user_id so future writes can't
  //      accidentally create a second row.
  if (!hasMigration("003_sessions_and_single_api_key")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          user_agent TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      `);

      // Keep the row most likely to be "active" (last_used_at, falling
      // back to created_at) per user; drop the rest.
      db.exec(`
        DELETE FROM api_keys
        WHERE id IN (
          SELECT id FROM (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY user_id
                ORDER BY
                  COALESCE(last_used_at, '') DESC,
                  created_at DESC,
                  id DESC
              ) AS rn
            FROM api_keys
          )
          WHERE rn > 1
        );
      `);

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_unique
          ON api_keys(user_id);
      `);

      recordMigration("003_sessions_and_single_api_key");
    })();
  }

  // 004: license_cache.owner_email — bind admin claim to the PromptOwl
  // account that minted the license key.
  if (!hasMigration("004_license_cache_owner_email")) {
    db.transaction(() => {
      const cols = (
        db.prepare("PRAGMA table_info(license_cache)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      if (!cols.includes("owner_email")) {
        db.exec("ALTER TABLE license_cache ADD COLUMN owner_email TEXT");
      }
      recordMigration("004_license_cache_owner_email");
    })();
  }

  // 005: anon-owned (ungoverned) nests default to public visibility.
  // Old rows were created with the schema default 'private', which hid
  // them from regular users in key mode even though the listNests path
  // still returned them — inconsistent state. One-shot backfill aligns
  // existing data with the new createNest default. Admin can flip
  // individual nests back to private via PATCH /nests/:id/visibility.
  if (!hasMigration("005_anon_nest_public_default")) {
    db.transaction(() => {
      db.prepare(
        "UPDATE nests SET visibility = 'public' WHERE user_id = ? AND visibility = 'private'",
      ).run(ANON_USER_ID);
      recordMigration("005_anon_nest_public_default");
    })();
  }

  // 006: add 'published' to node_versions.status CHECK. The no-stewards
  // save flow used to write two rows per edit (one 'approved' user row +
  // a system-author row mirroring the engine's publish bump). New flow
  // writes a single 'published' row at the engine's bumped version, so
  // governance numbering stays in lockstep with the on-disk frontmatter.
  // SQLite can't ALTER a CHECK in place — rebuild the table.
  if (!hasMigration("006_node_versions_published_status")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE node_versions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          author TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK(status IN ('draft', 'pending_review', 'approved', 'published', 'rejected')),
          change_note TEXT,
          tags_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(nest_id, node_id, version)
        );
        INSERT INTO node_versions_new
          (id, nest_id, node_id, version, content_hash, author, status, change_note, tags_json, created_at)
        SELECT
          id, nest_id, node_id, version, content_hash, author, status, change_note, tags_json, created_at
        FROM node_versions;
        DROP TABLE node_versions;
        ALTER TABLE node_versions_new RENAME TO node_versions;
        CREATE INDEX idx_versions_node ON node_versions(nest_id, node_id);
      `);
      recordMigration("006_node_versions_published_status");
    })();
  }

  // 007: drop legacy can_approve/can_reject columns from stewards.
  // Role is now the sole signal (reviewer = approve+reject).
  // Skip cleanly if columns are already gone (fresh installs, or repeat runs).
  if (!hasMigration("007_drop_steward_capability_flags")) {
    const stewardCols = (
      db.prepare("PRAGMA table_info(stewards)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    const hasLegacyCols =
      stewardCols.includes("can_approve") || stewardCols.includes("can_reject");
    if (hasLegacyCols) {
      db.transaction(() => {
        if (stewardCols.includes("can_approve")) {
          db.exec("ALTER TABLE stewards DROP COLUMN can_approve");
        }
        if (stewardCols.includes("can_reject")) {
          db.exec("ALTER TABLE stewards DROP COLUMN can_reject");
        }
        recordMigration("007_drop_steward_capability_flags");
      })();
    } else {
      recordMigration("007_drop_steward_capability_flags");
    }
  }

  // 008: drop folder scope from stewards.
  //   - hard-delete any existing folder rows (path-prefix matching removed
  //     from resolver, so keeping them would orphan data the UI can't see)
  //   - drop folder-specific partial indexes
  //   - rebuild stewards with tightened CHECK constraint ('document','tag','nest')
  if (!hasMigration("008_drop_steward_folder_scope")) {
    db.transaction(() => {
      db.exec("DELETE FROM stewards WHERE scope = 'folder'");
      db.exec("DROP INDEX IF EXISTS idx_stewards_uniq_folder");
      db.exec("DROP INDEX IF EXISTS idx_stewards_folder_lookup");

      // Rebuild only if current CHECK still allows folder. PRAGMA table_info
      // doesn't expose CHECK text; inspect sqlite_master.
      const tbl = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='stewards'")
        .get() as { sql?: string } | undefined;
      if (tbl?.sql && tbl.sql.includes("'folder'")) {
        db.exec(`
          CREATE TABLE stewards_new (
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
            assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
            is_active INTEGER NOT NULL DEFAULT 1
          );
          INSERT INTO stewards_new
            (id, nest_id, scope, node_pattern, tag_name, user_email, user_id,
             role, assigned_by, assigned_at, is_active)
          SELECT
            id, nest_id, scope, node_pattern, tag_name, user_email, user_id,
            role, assigned_by, assigned_at, is_active
          FROM stewards;
          DROP TABLE stewards;
          ALTER TABLE stewards_new RENAME TO stewards;

          CREATE INDEX idx_stewards_nest ON stewards(nest_id);
          CREATE INDEX idx_stewards_email ON stewards(user_email);
          CREATE INDEX idx_stewards_scope ON stewards(nest_id, scope);
          CREATE UNIQUE INDEX idx_stewards_uniq_nest
            ON stewards(nest_id, user_email)
            WHERE scope = 'nest' AND is_active = 1;
          CREATE UNIQUE INDEX idx_stewards_uniq_document
            ON stewards(nest_id, node_pattern, user_email)
            WHERE scope = 'document' AND node_pattern IS NOT NULL AND is_active = 1;
          CREATE UNIQUE INDEX idx_stewards_uniq_tag
            ON stewards(nest_id, tag_name, user_email)
            WHERE scope = 'tag' AND tag_name IS NOT NULL AND is_active = 1;
          CREATE INDEX idx_stewards_tag_lookup
            ON stewards(nest_id, tag_name)
            WHERE scope = 'tag' AND is_active = 1;
          CREATE INDEX idx_stewards_doc_lookup
            ON stewards(nest_id, node_pattern)
            WHERE scope = 'document' AND is_active = 1;
        `);
      }
      recordMigration("008_drop_steward_folder_scope");
    })();
  }
}
