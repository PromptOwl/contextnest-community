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

    -- Annotation threads on hosted artifacts. Deliberately kept OUT of the
    -- versioned/hash-chained node layer: annotations are high-churn human
    -- feedback, not canonical node content. They reference the node + the
    -- snapshot (node version) they were anchored against.
    CREATE TABLE IF NOT EXISTS annotation_threads (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      snapshot_version INTEGER,
      anchor_json TEXT,                 -- JSON {line?,quote,before,after}; NULL = whole-artifact
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'resolved')),
      created_by TEXT NOT NULL,         -- email
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_by TEXT,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS annotation_comments (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES annotation_threads(id) ON DELETE CASCADE,
      author TEXT NOT NULL,             -- email
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_annot_threads_node
      ON annotation_threads(nest_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_annot_comments_thread
      ON annotation_comments(thread_id);

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
  // Imported flag — set when a nest was created by importing a folder (its
  // files are copied into <DATA_ROOT>/nests/<id>). Drives the "Imported" badge
  // and flat document discovery (markdown anywhere, not just nodes/).
  if (!nestCols.includes("is_imported")) {
    db.exec("ALTER TABLE nests ADD COLUMN is_imported INTEGER NOT NULL DEFAULT 0");
  }

  // Per-nest self-approve bypass (default: off — separation of duties enforced).
  // When on, the submitter may approve their own version. See CU-86ahn99dg.
  if (!nestCols.includes("allow_self_approve")) {
    db.exec("ALTER TABLE nests ADD COLUMN allow_self_approve INTEGER NOT NULL DEFAULT 0");
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

  // 009: email is case-insensitive. Lowercase existing emails and enforce
  //   case-insensitive uniqueness so the same person can't become multiple
  //   user rows in different cases (which broke collaborator access + caused
  //   login lockouts — CU-wdqcpztrhf). Case-collision rows (two rows whose
  //   emails differ only in case) are NOT auto-merged — that would mean
  //   re-pointing api_keys / collaborators / sessions across users, which is
  //   unsafe to automate — they're logged for manual reconciliation instead.
  if (!hasMigration("009_lowercase_emails")) {
    db.transaction(() => {
      const collisions = db
        .prepare(
          `SELECT GROUP_CONCAT(email, ', ') AS emails
             FROM users GROUP BY LOWER(email) HAVING COUNT(*) > 1`,
        )
        .all() as Array<{ emails: string }>;
      for (const c of collisions) {
        console.warn(
          `[migration 009] case-collision user rows NOT auto-merged: ${c.emails} — reconcile manually (pick the row the person logs into; reset its password; ensure collaborator/steward grants point at that user_id).`,
        );
      }
      // Lowercase only the rows that won't collide with an existing row.
      db.exec(
        `UPDATE users SET email = LOWER(email)
           WHERE email <> LOWER(email)
             AND LOWER(email) NOT IN (
               SELECT LOWER(email) FROM users GROUP BY LOWER(email) HAVING COUNT(*) > 1
             )`,
      );
      // Enforce case-insensitive uniqueness going forward — but only when the
      // table is clean (a NOCASE unique index can't be built over remaining
      // collisions). Otherwise leave it and let the warning drive cleanup.
      const remaining = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM (
               SELECT 1 FROM users GROUP BY LOWER(email) HAVING COUNT(*) > 1
             )`,
          )
          .get() as { c: number }
      ).c;
      if (remaining === 0) {
        db.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE)",
        );
      } else {
        console.warn(
          `[migration 009] ${remaining} case-collision group(s) remain — skipping the NOCASE unique index until reconciled.`,
        );
      }
    })();
    recordMigration("009_lowercase_emails");
  }

  // 010: one-time-use store for PromptOwl SSO ticket IDs (jti). A ticket is
  // single-use — once its jti lands here it can't be replayed. expires_at
  // mirrors the ticket's exp so old rows can be pruned.
  if (!hasMigration("010_sso_used_jti")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sso_used_jti (
          jti TEXT PRIMARY KEY,
          used_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sso_used_jti_expires
          ON sso_used_jti(expires_at);
      `);
    })();
    recordMigration("010_sso_used_jti");
  }

  // 011: Collaboration comments (CU-wdqcpzudt3). A standalone annotation
  //   primitive — deliberately NOT part of the engine hash chain or version
  //   history. Comments are *about* a node, not a version of it: plain rows
  //   that carry attribution, thread, anchor to a highlighted span, and
  //   resolve. They feed the per-node activity log alongside reviews + edits.
  if (!hasMigration("011_comments")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY,
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          version INTEGER,                 -- optional: comment pinned to a version
          anchor_start INTEGER,            -- optional: highlight span start (char offset)
          anchor_end INTEGER,              -- optional: highlight span end
          anchor_text TEXT,                -- optional: quoted highlighted text
          parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,  -- threading
          author TEXT NOT NULL,            -- email
          body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open'
            CHECK(status IN ('open', 'resolved')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_by TEXT,                -- email
          resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_comments_node
          ON comments(nest_id, node_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_comments_open
          ON comments(nest_id, node_id, status);
        CREATE INDEX IF NOT EXISTS idx_comments_thread
          ON comments(parent_id);
      `);
    })();
    recordMigration("011_comments");
  }

  // 012: merge case-colliding user rows that 009 deliberately left for manual
  //   reconciliation. 009 only builds the NOCASE-unique email index when the
  //   table is already clean; pre-existing collisions (e.g. Bob@x.com AND
  //   bob@x.com) make login and admin reset resolve DIFFERENT rows — so
  //   "rotate the password and they still can't log in" and re-adding never
  //   helps. This merges each collision group into one user (repointing keys,
  //   sessions, ownership, collaborators, stewards and every email-keyed
  //   attribution column), then builds the NOCASE unique index 009 skipped.
  if (!hasMigration("012_merge_case_colliding_users")) {
    db.transaction(() => {
      const { groups, merged } = mergeCaseCollidingUsers(db);
      if (merged > 0) {
        console.warn(
          `[migration 012] merged ${merged} duplicate user row(s) across ${groups} case-collision group(s).`,
        );
      }
      // Canonicalize any remaining mixed-case emails 009 left behind. After the
      // merge each LOWER(email) group has exactly one row, so this can't collide.
      db.exec(
        "UPDATE users SET email = LOWER(email) WHERE email <> LOWER(email)",
      );
      // Enforce case-insensitive uniqueness going forward (009 skipped it while
      // collisions remained).
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE)",
      );
    })();
    recordMigration("012_merge_case_colliding_users");
  }

  // 019: document + folder sharing grants (CU-wdqcpzv656). A dedicated ACCESS
  //   model, distinct from stewardship (which is REVIEW governance). One row =
  //   "user has role on this document, or on everything under this folder
  //   prefix". Lets an owner/admin share a single doc or a folder with a
  //   person who isn't a nest-wide collaborator.
  if (!hasMigration("019_grants")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS grants (
          id TEXT PRIMARY KEY,
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL CHECK(target_type IN ('document', 'folder')),
          target TEXT NOT NULL,        -- node id (document) or path prefix (folder)
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('read', 'write')),
          granted_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_unique
          ON grants(nest_id, target_type, target, user_id);
        CREATE INDEX IF NOT EXISTS idx_grants_user ON grants(nest_id, user_id);
      `);
    })();
    recordMigration("019_grants");
  }

  // 013: deletion tombstones (CU-wdqcpzv219). DELETE /nodes purges every
  //   governance row for the node (so slug reuse works), which left external
  //   sync consumers (GitHub/GitBook mirrors) no way to learn a doc was
  //   removed. One tombstone row per (nest, node); re-deletion after a
  //   recreate updates it in place. GET /nests/:id/changes reads these.
  //   (Numbered 013 — 012 is reserved by the case-colliding-users merge on
  //   its own branch; ids are strings, arrival order doesn't matter.)
  if (!hasMigration("013_node_deletion_tombstones")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS node_deletions (
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          deleted_by TEXT,
          deleted_at TEXT NOT NULL,
          PRIMARY KEY (nest_id, node_id)
        );
        CREATE INDEX IF NOT EXISTS idx_node_deletions_time
          ON node_deletions(nest_id, deleted_at);
      `);
    })();
    recordMigration("013_node_deletion_tombstones");
  }

  // 014: activity trace (CU-wdqcpzv21h). One row per API request and per MCP
  //   tool invocation so the server admin has a single place to audit what
  //   every client and agent did. Simple form by design: who, what, where,
  //   outcome, duration. Pruned on a rolling window (see trace-log.ts).
  if (!hasMigration("014_api_events")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('api', 'mcp')),
          method TEXT,                 -- HTTP method (api rows)
          path TEXT,                   -- request path (api rows)
          tool TEXT,                   -- tool name (mcp rows)
          nest_id TEXT,
          user_id TEXT,
          user_email TEXT,
          status INTEGER,              -- HTTP status (api rows)
          duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_api_events_ts ON api_events(ts);
      `);
    })();
    recordMigration("014_api_events");
  }

  // 015: glossary definitions (CU-wdqcpzv2eg). A literal table-based
  //   ontology per nest: stewards define and articulate terms — existing
  //   tags or brand-new ones — and external runtimes (quant analysis jobs,
  //   agents) pull them in real time via GET /definitions?term=. One row
  //   per (nest, term), case-insensitive.
  if (!hasMigration("015_definitions")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS definitions (
          id TEXT PRIMARY KEY,
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          term TEXT NOT NULL,
          definition TEXT NOT NULL,
          linked_tag TEXT,               -- optional #tag this term maps to
          defined_by TEXT NOT NULL,      -- email
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_definitions_term
          ON definitions(nest_id, term COLLATE NOCASE);
      `);
    })();
    recordMigration("015_definitions");
  }

  // 016: workflow plane foundations (CU-wdqcpzv34u, "turing" track). Typed
  //   edges between nodes, with a steward-defined registry articulating what
  //   each connection MEANS (the definitions-table move, applied to
  //   relations). Feature-flagged: routes 404 unless FEATURE_WORKFLOW_PLANE
  //   is on, but the schema ships so flipping the flag needs no migration.
  //   Case-insensitive uniqueness via LOWER() (portable — NOT COLLATE
  //   NOCASE; keep in lockstep with migrations.postgres.ts).
  if (!hasMigration("016_workflow_edges")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS edge_types (
          id TEXT PRIMARY KEY,
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          direction TEXT NOT NULL DEFAULT 'directed'
            CHECK(direction IN ('directed', 'undirected')),
          is_flow INTEGER NOT NULL DEFAULT 0,   -- flow types form the DAG
          condition_schema TEXT,                -- JSON template | NULL
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
          -- RESTRICT (not CASCADE): the app refuses to delete an edge type
          -- while edges reference it; the DB backs that invariant instead of
          -- silently cascade-deleting live edges if the app check is bypassed.
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
      `);
    })();
    recordMigration("016_workflow_edges");
  }

  // 017: run records (CU-wdqcpzv363, "turing" track). One row per agent
  //   execution + an append-only step log — the operational trace that
  //   makes workflows replayable (reads are recorded as selector+hops;
  //   deterministic retrieval reproduces the identical read-set).
  if (!hasMigration("017_workflow_runs")) {
    db.transaction(() => {
      db.exec(`
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
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_runs_nest ON runs(nest_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(nest_id, agent_node);

        CREATE TABLE IF NOT EXISTS run_steps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          node_id TEXT,
          edge_id TEXT,
          action TEXT NOT NULL,
          detail TEXT,
          at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_run_steps ON run_steps(run_id, seq);
      `);
    })();
    recordMigration("017_workflow_runs");
  }

  // 018: sub-agent runs (CU-wdqcpzv3kp). parent_run_id links a nested run to
  //   the run that spawned it (the call tree); depth bounds recursion so the
  //   tree stays finite/haltable. Columns ship regardless of the
  //   FEATURE_SUBAGENT_RUNS flag (schema-first, flag gates behaviour).
  if (!hasMigration("018_subagent_runs")) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
        ALTER TABLE runs ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
      `);
    })();
    recordMigration("018_subagent_runs");
  }

  // 020: server_settings — durable store for runtime-mutable server config (the
  //   admin Settings page values + the installed license key). Replaces writing
  //   these to a .env file under DATA_ROOT, which was lost on every Cloud Run
  //   rebuild (the container filesystem is ephemeral) and never shared across
  //   horizontally scaled instances. Loaded into process.env at boot.
  //     value        — the effective setting; NULL = explicitly cleared (tombstone)
  //     env_at_write — the deploy-env value in effect when the row was written,
  //                    so a redeploy that CHANGES the env is detected and takes
  //                    precedence (operator intent) while an unchanged env lets
  //                    the stored UI edit win. See db/settings.ts.
  if (!hasMigration("020_server_settings")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS server_settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          env_at_write TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      recordMigration("020_server_settings");
    })();
  }

  // 020: interval schedules for the workflow plane. One row = "create a run
  //   for this agent every N minutes". The server loop (workflow/scheduler.ts)
  //   only inserts run rows on the interval; an external runner in poll mode
  //   executes them — the server itself never calls an LLM.
  if (!hasMigration("020_schedules")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
          id TEXT PRIMARY KEY,
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          agent_node TEXT NOT NULL,
          every_minutes INTEGER NOT NULL CHECK(every_minutes >= 5),
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_agent
          ON schedules(nest_id, agent_node);
      `);
    })();
    recordMigration("020_schedules");
  }

  // 021: schedule bounds — "run every N minutes UNTIL you've run K times".
  //   max_runs NULL = forever; runs_created counts firings; the scheduler
  //   auto-pauses the row when the bound is hit. This is the deterministic
  //   v1 of a goal condition; condition-based stopping (approve/metric)
  //   layers on later.
  if (!hasMigration("021_schedule_bounds")) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE schedules ADD COLUMN max_runs INTEGER;
        ALTER TABLE schedules ADD COLUMN runs_created INTEGER NOT NULL DEFAULT 0;
      `);
    })();
    recordMigration("021_schedule_bounds");
  }

  // 022: tools + HITL notify.
  //   nest_env — per-nest key/value store for tool credentials. Values are
  //     write-only through the API (masked on read); they travel to the
  //     runner inside the run bundle. NOT encrypted at rest — same trust
  //     domain as the nest content itself; document that honestly.
  //   watchers — "tag a person to a node": watchers of an agent (or of a
  //     document) get a notification row when a review request lands for
  //     the document / for the agent's output.
  //   notifications — the inbox rows behind /me/work; a Slack/webhook
  //     connector can drain these later without schema change.
  if (!hasMigration("022_tools_and_watchers")) {
    db.transaction(() => {
      db.exec(`
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
      `);
    })();
    recordMigration("022_tools_and_watchers");
  }

  // 023: connectors — outbound channels as data, not code. One dispatch
  //   engine; each row = "when <events> happen in this nest, POST to
  //   <channel-formatted> <url>". url may be a literal https URL or an
  //   "env:KEY" reference into the same env store tools use — connectors
  //   are part of the tools layer, lego-style.
  if (!hasMigration("023_connectors")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS connectors (
          id TEXT PRIMARY KEY,
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          channel TEXT NOT NULL CHECK(channel IN ('slack', 'teams', 'webhook')),
          url TEXT NOT NULL,               -- https://… or env:KEY
          events TEXT NOT NULL,            -- JSON array of kinds, or ["*"]
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_connectors_nest ON connectors(nest_id);
      `);
    })();
    recordMigration("023_connectors");
  }

  // 024: inbound trigger hooks — the listener face of the tools layer. One
  //   row = a tokenized public URL that creates a run for an agent. The
  //   preset decides the adapter: how to parse the caller's payload into run
  //   inputs, how to verify it (signing secret from the env store), and how
  //   to shape the ack (Slack wants {response_type,text} inside 3s).
  if (!hasMigration("024_trigger_hooks")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS trigger_hooks (
          id TEXT PRIMARY KEY,               -- the token (hk_…), capability auth
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
      `);
    })();
    recordMigration("024_trigger_hooks");
  }

  // 025: atomic run claiming. Two pollers seeing the same unclaimed run and
  //   both executing it means duplicate side effects — the claim column is
  //   the mutex: UPDATE … WHERE claimed_by IS NULL, check rows-affected.
  if (!hasMigration("025_run_claims")) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE runs ADD COLUMN claimed_by TEXT;
        ALTER TABLE runs ADD COLUMN claimed_at TEXT;
      `);
    })();
    recordMigration("025_run_claims");
  }

  // 026: composite index for the per-nest trace view (CU-wdqcpzw3u6).
  //   GET /nests/:id/trace filters WHERE nest_id = ? and pages ORDER BY id
  //   DESC — with only idx_api_events_ts (migration 014) that's a full table
  //   scan per request, and with TRACE_RETENTION_DAYS=0 the table can grow
  //   unbounded. (nest_id, id) serves both the filtered COUNT and the
  //   newest-first page window in one index walk.
  if (!hasMigration("026_api_events_nest_index")) {
    db.transaction(() => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_api_events_nest_ts ON api_events(nest_id, id);
      `);
    })();
    recordMigration("026_api_events_nest_index");
  }
}

/**
 * Merge user rows whose emails differ only in case into a single row per
 * person. Extracted from migration 012 so it can be unit-tested directly.
 *
 * For each LOWER(email) group with >1 row (excluding the anon sentinel) it
 * picks a winner — a real (claimed) account beats an invited placeholder, then
 * one with an active credential (API key / session), then the most recently
 * created — and repoints every reference from the losing rows to the winner:
 *
 *  - id-keyed FKs: sessions.user_id, nest_collaborators.user_id/granted_by,
 *    stewards.user_id, nests.user_id (UNIQUE(user_id, slug) — conflicting slugs
 *    are suffixed, never dropped), api_keys.user_id (UNIQUE(user_id) — keep the
 *    winner's key if present).
 *  - email-keyed attribution (no FK): annotation_threads.created_by/resolved_by,
 *    annotation_comments.author, review_requests.requested_by/resolved_by,
 *    node_versions.author, approved_versions.approved_by, comments.author/
 *    resolved_by, license_cache.owner_email, stewards.assigned_by/user_email.
 *
 * Idempotent: a no-op when there are no collisions. Run inside a transaction by
 * the caller. All repoints happen before each loser row is deleted so no FK
 * dangles (foreign_keys is ON).
 */
export function mergeCaseCollidingUsers(db: Database.Database): {
  groups: number;
  merged: number;
} {
  const groups = db
    .prepare(
      `SELECT LOWER(email) AS le
         FROM users
        WHERE id != ?
        GROUP BY LOWER(email)
       HAVING COUNT(*) > 1`,
    )
    .all(ANON_USER_ID) as Array<{ le: string }>;

  // Every table+column that stores a user's login email (no FK, so a miss
  // silently orphans attribution rather than erroring).
  const emailCols: Array<[string, string]> = [
    ["annotation_threads", "created_by"],
    ["annotation_threads", "resolved_by"],
    ["annotation_comments", "author"],
    ["review_requests", "requested_by"],
    ["review_requests", "resolved_by"],
    ["node_versions", "author"],
    ["approved_versions", "approved_by"],
    ["comments", "author"],
    ["comments", "resolved_by"],
    ["license_cache", "owner_email"],
    ["stewards", "assigned_by"],
  ];

  let merged = 0;
  for (const { le } of groups) {
    const rows = db
      .prepare(
        `SELECT u.id, u.email, u.is_invited, u.is_admin, u.name, u.created_at,
                (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS keys,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions
           FROM users u
          WHERE LOWER(u.email) = ? AND u.id != ?`,
      )
      .all(le, ANON_USER_ID) as Array<{
        id: string;
        email: string;
        is_invited: number;
        is_admin: number;
        name: string | null;
        created_at: string;
        keys: number;
        sessions: number;
      }>;
    if (rows.length < 2) continue;

    // Winner: claimed account (is_invited=0) > placeholder; then has an active
    // credential; then most recently created.
    rows.sort((a, b) => {
      if (a.is_invited !== b.is_invited) return a.is_invited - b.is_invited;
      const aCred = a.keys + a.sessions > 0 ? 1 : 0;
      const bCred = b.keys + b.sessions > 0 ? 1 : 0;
      if (aCred !== bCred) return bCred - aCred;
      return b.created_at.localeCompare(a.created_at);
    });
    const winner = rows[0];
    const losers = rows.slice(1);
    const anyAdmin = rows.some((r) => r.is_admin) ? 1 : 0;
    const winnerName = winner.name ?? rows.find((r) => r.name)?.name ?? null;

    for (const loser of losers) {
      const w = winner.id;
      const l = loser.id;
      const loserLower = loser.email.toLowerCase();

      // id-keyed repoints with no per-user uniqueness — bulk safe.
      db.prepare("UPDATE sessions SET user_id = ? WHERE user_id = ?").run(w, l);
      db.prepare(
        "UPDATE nest_collaborators SET granted_by = ? WHERE granted_by = ?",
      ).run(w, l);
      db.prepare("UPDATE stewards SET user_id = ? WHERE user_id = ?").run(w, l);

      // nests: UNIQUE(user_id, slug). Repoint non-conflicting slugs, then suffix
      // the leftovers so nothing is dropped.
      db.prepare(
        `UPDATE nests SET user_id = ?
           WHERE user_id = ?
             AND slug NOT IN (SELECT slug FROM nests WHERE user_id = ?)`,
      ).run(w, l, w);
      db.prepare(
        `UPDATE nests
            SET slug = slug || '-merged-' || substr(id, 1, 8), user_id = ?
          WHERE user_id = ?`,
      ).run(w, l);

      // api_keys: UNIQUE(user_id). Keep the winner's key if any, else promote
      // the loser's.
      db.prepare(
        `DELETE FROM api_keys
           WHERE user_id = ?
             AND EXISTS (SELECT 1 FROM api_keys WHERE user_id = ?)`,
      ).run(l, w);
      db.prepare("UPDATE api_keys SET user_id = ? WHERE user_id = ?").run(w, l);

      // nest_collaborators: one row per (nest, user). Dedupe then repoint, and
      // drop rows that would make the winner a collaborator on a nest they own.
      db.prepare(
        `DELETE FROM nest_collaborators
           WHERE user_id = ?
             AND nest_id IN (SELECT nest_id FROM nest_collaborators WHERE user_id = ?)`,
      ).run(l, w);
      db.prepare(
        "UPDATE nest_collaborators SET user_id = ? WHERE user_id = ?",
      ).run(w, l);
      db.prepare(
        `DELETE FROM nest_collaborators
           WHERE user_id = ?
             AND nest_id IN (SELECT id FROM nests WHERE user_id = ?)`,
      ).run(w, w);

      // email-keyed attribution — match case-insensitively, write the canonical
      // lowercased winner email. loserLower === le here, so this overwrites the
      // whole email group (winner + loser rows) to `le`; that's intentional and
      // idempotent — a plain overwrite, never a delete.
      for (const [table, col] of emailCols) {
        db.prepare(
          `UPDATE ${table} SET ${col} = ? WHERE LOWER(${col}) = ?`,
        ).run(le, loserLower);
      }

      // stewards.user_email has partial unique indexes per (nest, scope,
      // target, email) while is_active=1. Once every row in this email group is
      // canonicalized to `le`, rows that previously differed only in email case
      // would collide on those indexes. De-dup the active set down to ONE row
      // per (nest, scope, target) — keeping the lexically-first id — then
      // repoint the survivors (and any inactive rows) to the winner + canonical
      // email.
      //
      // NOTE: winner- and loser-owned rows are indistinguishable at this point
      // (user_id was already repointed to the winner above, and both carry the
      // same lowercased email), so this deliberately operates on the WHOLE email
      // group keyed by `le` rather than on "the loser's rows". Keeping exactly
      // one active row per target — instead of the previous self-satisfying
      // EXISTS, which deleted every active grant for the email — preserves the
      // person's steward assignments across the merge. Idempotent across losers.
      db.prepare(
        `DELETE FROM stewards
           WHERE is_active = 1
             AND LOWER(user_email) = ?
             AND id NOT IN (
               SELECT MIN(id) FROM stewards
                WHERE is_active = 1 AND LOWER(user_email) = ?
                GROUP BY nest_id, scope,
                         IFNULL(node_pattern, ''), IFNULL(tag_name, '')
             )`,
      ).run(le, le);
      db.prepare(
        "UPDATE stewards SET user_email = ?, user_id = ? WHERE LOWER(user_email) = ?",
      ).run(le, w, le);

      db.prepare("DELETE FROM users WHERE id = ?").run(l);
      merged++;
    }

    // Canonicalize the surviving winner row.
    db.prepare(
      "UPDATE users SET email = ?, is_admin = ?, name = ? WHERE id = ?",
    ).run(le, anyAdmin, winnerName, winner.id);
  }

  return { groups: groups.length, merged };
}
