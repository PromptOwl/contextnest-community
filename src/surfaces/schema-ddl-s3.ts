/**
 * Surfaces S3 tables (PRD §13, the seed engine). One DDL string for both
 * drivers (SQLite migration 082, Postgres parity).
 *
 *  - surface_seed_applications: which seed (and version, and source) a nest
 *    has, the listener settings it carries, and a short-lived apply claim
 *    (compare-and-set) so two applies on one nest never interleave.
 *  - surface_seed_items: one row per thing a seed wrote into a nest — folder,
 *    node, CONTEXT.md, definition — with `seed_origin` (<id>@<version>) and
 *    `seed_hash` (sha256 of what it wrote). A current hash that differs is a
 *    human edit and is never overwritten (AC-SEED-02).
 *  - surface_seed_mirror: org-mirror proposals already made (AC-SEED-07),
 *    keyed by subject, so re-applying proposes nothing twice. Holds ids only.
 *  - surface_settings.default_seed / seed_library_nests.
 */
/**
 * What a seed can write (PO-1411 adds a recipe's board, channel and task
 * stages to the S3 four). Widening this list needs migration 101 below.
 */
export const SEED_ITEM_KINDS = ["folder", "node", "context", "definition", "board", "channel", "task_rules"] as const;
const SEED_ITEM_KINDS_SQL = SEED_ITEM_KINDS.map((k) => `'${k}'`).join(", ");

/**
 * Migration 101 (SQLite): rebuild surface_seed_items with the wider kind
 * CHECK when the table still has the S3 one. SQLite can't alter a CHECK.
 */
export function seedItemKindsRebuildSqlite(now: string): string {
  return `
    CREATE TABLE surface_seed_items_new (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN (${SEED_ITEM_KINDS_SQL})),
      target TEXT NOT NULL,
      seed_id TEXT NOT NULL,
      item_key TEXT,
      seed_origin TEXT NOT NULL,
      seed_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (nest_id, kind, target)
    );
    INSERT INTO surface_seed_items_new (nest_id, kind, target, seed_id, item_key, seed_origin, seed_hash, created_at, updated_at)
      SELECT nest_id, kind, target, seed_id, item_key, seed_origin, seed_hash, created_at, updated_at FROM surface_seed_items;
    DROP TABLE surface_seed_items;
    ALTER TABLE surface_seed_items_new RENAME TO surface_seed_items;
  `;
}

/** Migration 101 (Postgres): swap the kind CHECK for the wider one, once. */
export function seedItemKindsPostgres(): string {
  return `
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'surface_seed_items_kind_check'
                  AND pg_get_constraintdef(oid) NOT LIKE '%task_rules%') THEN
        ALTER TABLE surface_seed_items DROP CONSTRAINT surface_seed_items_kind_check;
        ALTER TABLE surface_seed_items ADD CONSTRAINT surface_seed_items_kind_check CHECK (kind IN (${SEED_ITEM_KINDS_SQL}));
      END IF;
    END $$;
  `;
}

export function surfacesS3Ddl(now: string): string {
  return `
    CREATE TABLE IF NOT EXISTS surface_seed_applications (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      seed_id TEXT NOT NULL,
      seed_version INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('bundled', 'library')),
      library_nest_id TEXT,
      listener_json TEXT NOT NULL DEFAULT '{}',
      applied_by TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (nest_id, seed_id)
    );

    CREATE TABLE IF NOT EXISTS surface_seed_claims (
      nest_id TEXT PRIMARY KEY REFERENCES nests(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS surface_seed_items (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN (${SEED_ITEM_KINDS_SQL})),
      target TEXT NOT NULL,
      seed_id TEXT NOT NULL,
      item_key TEXT,
      seed_origin TEXT NOT NULL,
      seed_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${now},
      updated_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (nest_id, kind, target)
    );

    -- S7-R2 L7: a DM nest whose default seed failed backs off and tells its owner once.
    CREATE TABLE IF NOT EXISTS surface_seed_default_failures (
      nest_id TEXT PRIMARY KEY REFERENCES nests(id) ON DELETE CASCADE,
      failed_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      notified INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS surface_seed_mirror (
      nest_id TEXT NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('person', 'area')),
      subject_key TEXT NOT NULL,
      install_id TEXT,
      node_id TEXT,
      review_id TEXT,
      created_at TEXT NOT NULL DEFAULT ${now},
      PRIMARY KEY (nest_id, kind, subject_key)
    );
  `;
}

const SURFACES_S3_COLUMNS: Array<[string, string, string]> = [
  ["surface_settings", "default_seed", "TEXT NOT NULL DEFAULT 'generic-team'"],
  ["surface_settings", "seed_library_nests", "TEXT NOT NULL DEFAULT '[]'"],
];

export function surfacesS3AlterSqlite(): string {
  return SURFACES_S3_COLUMNS.map(([t, c, ty]) => `ALTER TABLE ${t} ADD COLUMN ${c} ${ty};`).join("\n");
}

export function surfacesS3AlterPostgres(): string {
  return SURFACES_S3_COLUMNS.map(([t, c, ty]) => `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${ty};`).join("\n");
}
