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
        CHECK(visibility IN ('private', 'org', 'public')),
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

  // Prime documents: a per-doc / per-tag escalation that forces the full
  // draft → pending → approved cycle even when the actor would otherwise
  // auto-publish. `prime_only_review` flips the governed nest's default from
  // "review everything" to "review only prime docs"; off by default so
  // existing governed nests keep their current posture on upgrade.
  if (!nestCols.includes("prime_only_review")) {
    db.exec("ALTER TABLE nests ADD COLUMN prime_only_review INTEGER NOT NULL DEFAULT 0");
  }
  if (!nestCols.includes("prime_tags")) {
    db.exec("ALTER TABLE nests ADD COLUMN prime_tags TEXT NOT NULL DEFAULT 'prime-document'");
  }

  // Creator reviews their documents: on create, the author becomes the
  // document's reviewer steward and v1 publishes. Off by default so a governed
  // nest keeps routing new documents to its assigned reviewers on upgrade.
  if (!nestCols.includes("creator_is_reviewer")) {
    db.exec("ALTER TABLE nests ADD COLUMN creator_is_reviewer INTEGER NOT NULL DEFAULT 0");
  }

  // Freshness stamp for node_index (migration 036). NULL means "rebuild before
  // answering" — the state every existing nest starts in on upgrade, and the
  // state any write we could not mirror puts it back into.
  if (!nestCols.includes("index_synced_at")) {
    db.exec("ALTER TABLE nests ADD COLUMN index_synced_at TEXT");
  }

  // Push Confirmation Gate (superadmin). When on, an agent write (POST
  // /nests/:id/publish) is HELD as a pending_pushes row instead of applying —
  // it lands only after a reviewer confirms in the web UI. Default 0 keeps
  // today's immediate-apply behaviour. Superadmin-set only (isServerAdminUserId
  // gates the settings field); mirrors allow_self_approve above.
  if (!nestCols.includes("require_push_confirmation")) {
    db.exec(
      "ALTER TABLE nests ADD COLUMN require_push_confirmation INTEGER NOT NULL DEFAULT 0",
    );
  }
  // Public Docs Reader Mode — a superadmin-enabled, read-only public docs view.
  // `reader_mode` off by default; `reader_home_node` names the designated
  // landing/hub node (nullable — resolved by convention when unset).
  if (!nestCols.includes("reader_mode")) {
    db.exec("ALTER TABLE nests ADD COLUMN reader_mode INTEGER NOT NULL DEFAULT 0");
  }
  if (!nestCols.includes("reader_home_node")) {
    db.exec("ALTER TABLE nests ADD COLUMN reader_home_node TEXT");
  }

  // Per-nest reader branding (CU-wdqcq02ptm): one validated JSON document —
  // logo, banner, colors, site title, footer, favicon. NULL = unbranded, which
  // renders exactly as before. See src/shared/branding.ts.
  if (!nestCols.includes("branding_json")) {
    db.exec("ALTER TABLE nests ADD COLUMN branding_json TEXT");
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

  // 027: teams (CU-wdqcpzw451). A reusable group primitive — a named set of
  //   members, each with a role — owned/managed by its creator. Sharing a team
  //   onto a nest records the team on `nests.shared_teams`; every member then
  //   resolves to their own member role on that nest (see resolveNestPermission
  //   / resolveUserRoles). Members are stored INLINE as a JSON roster rather
  //   than a join table so a team is fetched/managed as one row. Role lives on
  //   the member (uniform across every nest the team is shared to), not on the
  //   share. `nests.shared_teams` holds [{teamId, teamName}] — teamId is
  //   canonical, teamName a cached display label refreshed on team rename.
  if (!hasMigration("027_teams")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS teams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          members TEXT NOT NULL DEFAULT '[]',   -- JSON [{userId, email, role}]
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_id);
      `);
      const nestColsNow = (db.prepare("PRAGMA table_info(nests)").all() as Array<{ name: string }>).map((c) => c.name);
      if (!nestColsNow.includes("shared_teams")) {
        db.exec("ALTER TABLE nests ADD COLUMN shared_teams TEXT NOT NULL DEFAULT '[]'");
      }
    })();
    recordMigration("027_teams");
  }

  // 028: directory department on users (CU-wdqcpzwf2p). Captured from the
  //   OIDC `department` claim on every SSO login — upserted to the claim's
  //   value, cleared (NULL) when the claim is absent, so directory moves
  //   propagate on the next sign-in. Read by the optional dept:<slug>
  //   auto-tag on node create (OIDC_DEPARTMENT_TAGGING). Nullable: password
  //   users and IdPs that don't emit the claim simply never set it.
  if (!hasMigration("028_user_department")) {
    db.transaction(() => {
      const userColsNow = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name);
      if (!userColsNow.includes("department")) {
        db.exec("ALTER TABLE users ADD COLUMN department TEXT");
      }
    })();
    recordMigration("028_user_department");
  }

  // 029: DB-backed superadmins (CU-wdqcpzwf2n). One row = "this email is a
  //   server admin", granted from the UI/API. The effective superadmin set is
  //   access.yaml `super_admins` ∪ these rows (case-insensitive; emails are
  //   stored lowercased). access.yaml stays the authoritative bootstrap:
  //   file entries can never be revoked via the API (lockout safety) — this
  //   table only holds the grants made at runtime.
  if (!hasMigration("029_super_admins")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS super_admins (
          email TEXT PRIMARY KEY,          -- stored lowercased
          granted_by TEXT NOT NULL,        -- email of the granting admin
          granted_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    })();
    recordMigration("029_super_admins");
  }

  // 031: provenance for imported teams (CU-wdqcpzwc6b). A team imported from
  //   PromptOwl records where it came from (`source`) and its id in that system
  //   (`external_id`), which is what makes a re-import update the same row
  //   instead of minting a duplicate — name is not a key, since either side can
  //   rename. Both columns are NULL on every hand-made team, which keeps the
  //   existing create/manage paths untouched. The unique index is partial so
  //   those NULL rows don't collide with each other, and is keyed by owner too:
  //   the same upstream team imported by two different people is two unrelated
  //   local teams, each owned by its importer.
  if (!hasMigration("031_team_source")) {
    db.transaction(() => {
      const teamCols = (
        db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!teamCols.includes("source")) {
        db.exec("ALTER TABLE teams ADD COLUMN source TEXT");
      }
      if (!teamCols.includes("external_id")) {
        db.exec("ALTER TABLE teams ADD COLUMN external_id TEXT");
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_external
          ON teams(owner_id, source, external_id)
          WHERE external_id IS NOT NULL;
      `);
    })();
    recordMigration("031_team_source");
  }

  // 032: deletion requests (CU-wdqcpzxqcm). Deleting a node is a write-tier
  //   action, so everyone below it needs a way to flag stale content instead of
  //   asking in Slack. Deliberately NOT a row in review_requests: a flagged node
  //   is not under review, and reusing that table would trip the pending-review
  //   edit lock and the content-review feed. One pending row per (nest, node);
  //   an honoured request is purged with the node's other rows (see
  //   NODE_KEYED_TABLES), a declined one keeps the reviewer's note.
  if (!hasMigration("032_deletion_requests")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS deletion_requests (
          id TEXT PRIMARY KEY,
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          requested_by TEXT NOT NULL,      -- email
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'declined')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_by TEXT,                -- email
          resolved_at TEXT,
          resolution_note TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_deletion_requests_pending
          ON deletion_requests(nest_id, node_id) WHERE status = 'pending';
        CREATE INDEX IF NOT EXISTS idx_deletion_requests_nest
          ON deletion_requests(nest_id, status);
      `);
    })();
    recordMigration("032_deletion_requests");
  }

  // 033: a deletion request can target a whole folder or the nest, not just one
  //   document (CU-wdqcpzxqcm follow-up). `node_id` carries the target for all
  //   three — a node id, a folder path ("api/limits"), or the nest id — so the
  //   queue, notifications and resolve path stay one code path. The pending
  //   index gains target_type: a folder and a document can share a string.
  if (!hasMigration("033_deletion_request_targets")) {
    db.transaction(() => {
      const cols = (
        db
          .prepare("PRAGMA table_info(deletion_requests)")
          .all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!cols.includes("target_type")) {
        db.exec(
          "ALTER TABLE deletion_requests ADD COLUMN target_type TEXT NOT NULL DEFAULT 'document'",
        );
      }
      db.exec(`
        DROP INDEX IF EXISTS idx_deletion_requests_pending;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_deletion_requests_pending
          ON deletion_requests(nest_id, target_type, node_id) WHERE status = 'pending';
      `);
    })();
    recordMigration("033_deletion_request_targets");
  }

  // 034: index behind /me/drafts. That query scans node_versions by author +
  //   status ('draft'/'rejected'); without this it's a full table scan on every
  //   dashboard load. Not in the base DDL because migration 006 rebuilds the
  //   table and would drop it on a fresh database.
  if (!hasMigration("034_versions_author_status_index")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_versions_author_status
        ON node_versions(author, status);
    `);
    recordMigration("034_versions_author_status_index");
  }

  // 035: Undo 003's one-key-per-user cap.
  //
  // A single key made rotation destructive at a distance: a user who had
  // wired four clients and lost the plaintext had to rotate to get a
  // readable key, which silently killed all four. Many keys means one per
  // place, and rotating one leaves the others alone. The non-unique
  // idx_keys_user index (created above) still covers lookups by user.
  if (!hasMigration("035_multiple_api_keys_per_user")) {
    db.exec(`DROP INDEX IF EXISTS idx_api_keys_user_unique;`);
    recordMigration("035_multiple_api_keys_per_user");
  }

  // 036: node_index — the document list, in the database (CU-wdqcq00ar3).
  //
  // Document existence/title/type/tags/folder live only on disk, so every
  // listing re-walked the vault and parsed every file. On a Cloud Storage
  // mount each of those reads is a network round trip, which is the whole of
  // the localhost-fast / cloud-slow gap: the in-process discovery cache dies
  // with the instance, so the cloud pays the crawl and localhost never does.
  //
  // Disk stays the source of truth; this is a derived mirror, written through
  // on every document write and rebuilt from disk whenever nests.index_synced_at
  // is NULL. frontmatter_json carries the whole frontmatter so a row rehydrates
  // into the ContextNode shape every consumer already speaks; the plain columns
  // beside it exist only so folder grouping and type/status filters run in SQL.
  if (!hasMigration("036_node_index")) {
    db.transaction(() => {
      db.exec(`
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

        -- Which documents have an external edit staged against them.
        --
        -- Its own table rather than a node_index column: node_index rows are
        -- upserted with INSERT OR REPLACE on every document write, which
        -- resets any column the write does not carry — and a suggestion's
        -- existence has nothing to do with the document write that would
        -- clobber it. Kept in step at the three points that stage, approve or
        -- reject a suggestion, and refreshed wholesale by a rebuild.
        CREATE TABLE IF NOT EXISTS node_suggestions (
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          PRIMARY KEY (nest_id, node_id)
        );
      `);
    })();
    recordMigration("036_node_index");
  }

  // 037: Publish — gated public hosting of a single document (CU-wdqcpzzp7y).
  //   `publish` holds one shareable /p/<slug> link per document with an access
  //   mode; `access_grant` is the per-publish record store (invite allow-list,
  //   one-time magic-link tokens, cookie sessions, and the view log), keyed by
  //   `kind`. Not in the base DDL — additive feature tables.
  if (!hasMigration("037_publish")) {
    db.transaction(() => {
      db.exec(`
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
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT,
          revoked_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_slug ON publish(slug);
        CREATE INDEX IF NOT EXISTS idx_publish_nest ON publish(nest_id, node_id);

        CREATE TABLE IF NOT EXISTS access_grant (
          id TEXT PRIMARY KEY,
          publish_id TEXT NOT NULL REFERENCES publish(id) ON DELETE CASCADE,
          kind TEXT NOT NULL
            CHECK(kind IN ('invite','link','session','view')),
          email TEXT,
          token_hash TEXT,
          expires_at TEXT,
          used_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_access_grant_publish ON access_grant(publish_id, kind);
        CREATE INDEX IF NOT EXISTS idx_access_grant_token ON access_grant(token_hash);
      `);
    })();
    recordMigration("037_publish");
  }

  // 037b: the viewer overlays (watermark / no-download). Declared inline in the
  // CREATE TABLE above, so this ALTER only fires for a database that ran an
  // earlier build of 037 — same inline-plus-explicit-ALTER pattern the teams
  // and prime columns use.
  {
    const publishCols = (
      db.prepare("PRAGMA table_info(publish)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (publishCols.length && !publishCols.includes("watermark")) {
      db.exec("ALTER TABLE publish ADD COLUMN watermark INTEGER NOT NULL DEFAULT 0");
    }
    if (publishCols.length && !publishCols.includes("no_download")) {
      db.exec("ALTER TABLE publish ADD COLUMN no_download INTEGER NOT NULL DEFAULT 0");
    }
  }

  // 038: archive a nest instead of deleting it (CU-wdqcpzy80h). One nullable
  //   timestamp — archiving is a date, not a state machine, and NULL is the
  //   whole "not archived" story, so every existing row is correct as-is.
  if (!hasMigration("038_nest_archive")) {
    const cols = (
      db.prepare("PRAGMA table_info(nests)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!cols.includes("archived_at")) {
      db.exec("ALTER TABLE nests ADD COLUMN archived_at TEXT");
    }
    recordMigration("038_nest_archive");
  }

  // 039: pinned nests (CU-wdqcq00d63). A pin is per PERSON per nest, not a
  //   property of the nest — two people sharing one nest pin different things —
  //   so it is its own table rather than a column. The composite primary key is
  //   the whole uniqueness rule (pinning twice is a no-op), and the nest FK
  //   cascades so a deleted nest takes its pins with it.
  if (!hasMigration("039_nest_pins")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS nest_pins (
          -- BOTH sides cascade, as grants and nest_collaborators do. Without it
          -- on user_id, deleting an account with a single pin fails the whole
          -- transaction on a foreign-key violation (foreign_keys is ON).
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, nest_id)
        );
        CREATE INDEX IF NOT EXISTS idx_nest_pins_user ON nest_pins(user_id);
      `);
    })();
    recordMigration("039_nest_pins");
  }

  // 040: Push Confirmation Gate. Held pushes + the per-key allowlist.
  //
  // pending_pushes carries the FULL staged push (payload_blob) so a confirm
  // applies it byte-for-byte later — the submitter is long gone by then.
  // push_allowlist is PER-API-KEY (never keyed on nest alone): key_id ''
  // means "any of that user's keys". A confirm with always_allow whitelists
  // the exact (nest_id, submitter_user_id, submitter_key_id) that pushed.
  if (!hasMigration("040_push_confirmation")) {
    db.transaction(() => {
      db.exec(`
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
      `);
    })();
    recordMigration("040_push_confirmation");
  }
  // 041: widen nests.visibility to accept 'org'. 040 is skipped on purpose —
  // 040_push_confirmation is in flight on another branch, and ids are matched
  // by string, so the gap costs nothing and reusing 040 would collide.
  //
  // See widenNestVisibilityCheck for why this is a table rebuild and why the
  // pragma is toggled out here —
  // PRAGMA foreign_keys is a no-op inside a transaction, so doing it any other
  // way silently leaves enforcement ON and cascades the database away.
  if (!hasMigration("041_nest_visibility_org")) {
    widenNestVisibilityWithGuard(db);
    recordMigration("041_nest_visibility_org");
  }

  // 042: official community site connections (CU-wdqcq0247t). Extends the
  // single OFFICIAL_COMMUNITY_SSO_SECRET / PUBLIC_BASE_URL env-var pair to a
  // DB-backed list so an operator can trust SSO tickets from multiple
  // official sites, each with its own name/url/secret and an active flag.
  // Managed from Server Settings via /admin/community-sites; see
  // src/auth/community-sites.ts.
  if (!hasMigration("042_community_sites")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS community_sites (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT NOT NULL UNIQUE,
          secret TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      recordMigration("042_community_sites");
    })();
  }

  // 043: node_suggestions carries the suggestion itself, not just a flag —
  // one row per staged external edit (id, who, when, source, hashes, note),
  // so the External Edits list and its badge are a SELECT and the UI can
  // tell an old suggestion from a new one. The old flag rows carried no id,
  // so the table is rebuilt empty and every nest's index is marked stale:
  // the next rebuild re-fills it from disk (node-index rebuild).
  if (!hasMigration("043_node_suggestion_details")) {
    db.transaction(() => {
      db.exec(`
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
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (nest_id, node_id, suggestion_id)
        );
        CREATE INDEX IF NOT EXISTS idx_node_suggestions_nest_detected
          ON node_suggestions(nest_id, detected_at DESC);
        UPDATE nests SET index_synced_at = NULL;
      `);
      recordMigration("043_node_suggestion_details");
    })();
  }

  // 044: caller attribution (spec §9.4). One nullable JSON column per audit
  //   surface — the version a write sealed, and the activity trace every call
  //   lands on. Nullable and unindexed on purpose: `client` is an annotation
  //   nobody queries by, and NULL is the whole "not attributed" story, so every
  //   existing row is already correct. Never part of any hash.
  //
  //   Numbered 044, not 040: 040 is reserved for 040_push_confirmation, in
  //   flight on another branch (see the note on 041), and ids match by string.
  if (!hasMigration("044_client_attribution")) {
    for (const [table, col] of [
      ["node_versions", "client_json"],
      ["api_events", "client_json"],
    ] as const) {
      const cols = (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (cols.length && !cols.includes(col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
      }
    }
    recordMigration("044_client_attribution");
  }

  // 046: attribute deletions (CU-wdqcq0314v). A delete purges every row tied
  //   to the node, so its tombstone is the only record left — which makes it
  //   where "which agent deleted this" has to live for the agent-activity
  //   stream. Same nullable, never-hashed annotation as 044. (045 is taken by
  //   045_mcp_oauth on another branch; ids match by string.)
  if (!hasMigration("046_deletion_client_attribution")) {
    const cols = (
      db.prepare(`PRAGMA table_info(node_deletions)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (cols.length && !cols.includes("client_json")) {
      db.exec(`ALTER TABLE node_deletions ADD COLUMN client_json TEXT`);
    }
    recordMigration("046_deletion_client_attribution");
  }

  // 047: document access events (CU-wdqcq03aw2). Reads, retrievals and exports
  //   leave no version behind, and the activity trace (api_events) records a
  //   call but not which documents it returned — so "who pulled this doc" had
  //   no answer. One row per (actor, document, action), throttled at write time
  //   and pruned on the trace's retention window (access-log.ts). node_id is
  //   NULL for a whole-nest export. (045 is taken on other branches.)
  if (!hasMigration("047_node_access_events")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS node_access_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        CREATE INDEX IF NOT EXISTS idx_node_access_node
          ON node_access_events(nest_id, node_id, id);
        CREATE INDEX IF NOT EXISTS idx_node_access_nest
          ON node_access_events(nest_id, id);
        CREATE INDEX IF NOT EXISTS idx_node_access_ts ON node_access_events(ts);
      `);
    })();
    recordMigration("047_node_access_events");
  }

  // 045: headless publishing (CU-wdqcq0314u). `nests.headless` is the owner's
  // "API-only" switch; `users.is_service` marks the identity behind an access
  // key (no password, never listed as a person); `headless_readers` ties each
  // such identity to the one nest its key reads.
  if (!hasMigration("045_headless_publish")) {
    db.transaction(() => {
      const nestCols = (
        db.prepare("PRAGMA table_info(nests)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!nestCols.includes("headless")) {
        db.exec("ALTER TABLE nests ADD COLUMN headless INTEGER NOT NULL DEFAULT 0");
      }
      const userCols = (
        db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!userCols.includes("is_service")) {
        db.exec("ALTER TABLE users ADD COLUMN is_service INTEGER NOT NULL DEFAULT 0");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS headless_readers (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
          key_id TEXT NOT NULL,
          label TEXT NOT NULL,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_headless_readers_nest ON headless_readers(nest_id);
      `);
    })();
    recordMigration("045_headless_publish");
  }
}

/**
 * `foreign_key_check` violations, counted per (child table, parent table,
 * constraint) — deliberately WITHOUT rowid, because the rebuild reassigns
 * rowids in `nests` and keying on them would report every pre-existing
 * violation there as newly introduced.
 */
function fkViolationCounts(db: Database.Database): Map<string, number> {
  const rows = db.pragma("foreign_key_check") as Array<{
    table: string;
    parent: string;
    fkid: number;
  }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.table}|${r.parent}|${r.fkid}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Run the `nests` rebuild with foreign keys disabled, and verify it introduced
 * no new dangling rows.
 *
 * The comparison is before-vs-after, not "are there any violations at all".
 * `PRAGMA foreign_key_check` with no argument scans the WHOLE database, and
 * runMigrations is called uncaught from openSqlite() at startup — so failing
 * on any violation would wedge boot permanently for a deployment carrying
 * unrelated pre-existing corruption (a hand-edited database, a restore taken
 * with foreign_keys off, a historic bug). That deployment's data is not this
 * migration's doing and re-running cannot fix it: the rebuild is idempotent,
 * so every subsequent boot would re-find the same violations and throw again.
 * Only violations this rebuild ADDED are its business.
 *
 * Still a detection net rather than a rollback: the rebuild's transaction has
 * necessarily committed by the time the check runs, because foreign_keys can
 * only be toggled outside a transaction. A throw leaves the new table in place
 * and the migration unrecorded; the retry is harmless because
 * widenNestVisibilityCheck returns early once 'org' is in the constraint.
 */
export function widenNestVisibilityWithGuard(db: Database.Database): void {
  const before = fkViolationCounts(db);
  const fkWasOn = db.pragma("foreign_keys", { simple: true }) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      widenNestVisibilityCheck(db);
    })();
    const after = fkViolationCounts(db);
    const introduced = [...after].filter(
      ([key, n]) => n > (before.get(key) ?? 0),
    );
    if (introduced.length > 0) {
      throw new Error(
        `041_nest_visibility_org introduced foreign-key violations: ${introduced
          .map(([key]) => key)
          .join(", ")}`,
      );
    }
  } finally {
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
}

/**
 * Widen the `nests.visibility` CHECK constraint to allow 'org'.
 *
 * SQLite cannot alter a CHECK in place, so the table has to be rebuilt — and
 * `nests` is the most-referenced table in the schema: 27 tables point at
 * `nests(id)`, every one of them ON DELETE CASCADE. The connection runs with
 * `foreign_keys = ON` (db/client.ts), so a plain `DROP TABLE nests` would take
 * every node-index row, version, steward, grant and run with it. The caller
 * MUST disable foreign keys around this, outside any transaction.
 *
 * The replacement table is derived from the LIVE schema rather than a literal
 * column list: `nests` grows columns from plain ALTERs on other branches
 * (marketplace adds is_pack/pack_meta/installed_from_pack), and a hardcoded
 * list would quietly drop whichever ones this file had not heard about.
 *
 * Idempotent — returns immediately once 'org' is already in the constraint.
 */
export function widenNestVisibilityCheck(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nests'")
    .get() as { sql?: string } | undefined;
  const ddl = row?.sql;
  if (!ddl) return; // fresh database — the CREATE TABLE above already has 'org'

  const checkRe = /CHECK\s*\(\s*visibility\s+IN\s*\([^)]*\)\s*\)/i;
  const current = ddl.match(checkRe);
  if (!current) return; // no visibility CHECK to widen — nothing to do
  if (/'org'/i.test(current[0])) return; // already widened

  const newDdl = ddl
    .replace(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?nests["'`\]]?/i,
      "CREATE TABLE nests_new",
    )
    .replace(checkRe, "CHECK(visibility IN ('private', 'org', 'public'))");
  if (!newDdl.startsWith("CREATE TABLE nests_new")) {
    throw new Error("041: could not rewrite the nests CREATE TABLE statement");
  }

  const cols = (db.prepare("PRAGMA table_info(nests)").all() as Array<{ name: string }>)
    .map((c) => `"${c.name}"`)
    .join(", ");

  // Indexes die with the DROP, so replay the live ones for the same reason the
  // columns are derived rather than hardcoded: other branches add them.
  const indexes = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nests' AND sql IS NOT NULL",
      )
      .all() as Array<{ sql: string }>
  ).map((r) => `${r.sql};`);

  db.exec(`
    ${newDdl};
    INSERT INTO nests_new (${cols}) SELECT ${cols} FROM nests;
    DROP TABLE nests;
    ALTER TABLE nests_new RENAME TO nests;
    ${indexes.join("\n    ")}
  `);
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
