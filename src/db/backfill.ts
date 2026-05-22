/**
 * One-shot backfill: mirror every engine history.yaml entry into the
 * node_versions table.
 *
 * Pre-existing nests have docs whose on-disk version sits ahead of the
 * DB because the steward-approve flow used to call publishDocument
 * without inserting a matching node_versions row. After the code fix in
 * review-service.ts, new approvals stay in sync — but historic docs are
 * still stuck, so every save 409s. This runs once per deployment to
 * catch them up.
 *
 * Gated via schema_migrations so it doesn't repeat on restart.
 */

import { NestStorage } from "@promptowl/contextnest-engine";
import type Database from "better-sqlite3";
import { join } from "path";
import { config } from "../config.js";

const MIGRATION_ID = "005_backfill_node_versions_from_history";

type NestRow = { id: string };

interface VersionRowExisting {
  version: number;
}

interface VersionEntryLike {
  version: number;
  edited_by: string;
  edited_at: string;
  content_hash: string;
  note?: string;
}

/**
 * Mirror missing history.yaml entries into node_versions for every
 * document in every nest. Idempotent — only inserts rows that don't
 * already exist (gated by the UNIQUE(nest_id, node_id, version)
 * constraint).
 */
export async function backfillNodeVersionsFromHistory(
  db: Database.Database,
): Promise<void> {
  const already = db
    .prepare("SELECT id FROM schema_migrations WHERE id = ?")
    .get(MIGRATION_ID);
  if (already) return;

  const nests = db.prepare("SELECT id FROM nests").all() as NestRow[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO node_versions
       (nest_id, node_id, version, content_hash, author, status, change_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const approvedPin = db.prepare(
    `INSERT OR REPLACE INTO approved_versions
       (nest_id, node_id, approved_version, approved_by, approved_at)
     VALUES (?, ?, ?, ?, COALESCE(
       (SELECT approved_at FROM approved_versions WHERE nest_id = ? AND node_id = ?),
       datetime('now')))`,
  );

  let totalInserted = 0;
  let totalDocs = 0;

  for (const { id: nestId } of nests) {
    const nestPath = join(config.DATA_ROOT, "nests", nestId);
    const storage = new NestStorage(nestPath);

    let docs;
    try {
      docs = await storage.discoverDocuments();
    } catch (err) {
      console.warn(
        `[backfill] discoverDocuments failed for nest ${nestId}:`,
        (err as Error).message,
      );
      continue;
    }

    for (const doc of docs) {
      totalDocs += 1;
      let history;
      try {
        history = await storage.readHistory(doc.id);
      } catch {
        history = null;
      }
      if (!history || history.versions.length === 0) continue;

      const existing = db
        .prepare(
          `SELECT version FROM node_versions WHERE nest_id = ? AND node_id = ?`,
        )
        .all(nestId, doc.id) as VersionRowExisting[];
      const known = new Set(existing.map((r) => r.version));

      const tagsJson = doc.frontmatter.tags
        ? JSON.stringify(doc.frontmatter.tags)
        : null;
      const latestVersion = history.versions[history.versions.length - 1].version;

      for (const entry of history.versions as VersionEntryLike[]) {
        if (known.has(entry.version)) continue;
        // Mark every backfilled row "approved" — they're all already
        // persisted to history.yaml, which the engine only writes on
        // publish or accepted edits. Reviews that never resolved live
        // in review_requests, not history.
        insert.run(
          nestId,
          doc.id,
          entry.version,
          entry.content_hash || "",
          entry.edited_by || "system:backfill",
          "approved",
          entry.note || null,
          entry.edited_at || new Date().toISOString(),
        );
        totalInserted += 1;
      }

      // If approved_versions has no pin (or points to a stale version),
      // pin to the latest history entry so getDisplayStatus resolves
      // correctly post-backfill.
      const pin = db
        .prepare(
          `SELECT approved_version FROM approved_versions WHERE nest_id = ? AND node_id = ?`,
        )
        .get(nestId, doc.id) as { approved_version: number } | undefined;
      if (!pin || pin.approved_version < latestVersion) {
        approvedPin.run(
          nestId,
          doc.id,
          latestVersion,
          history.versions[history.versions.length - 1].edited_by ||
            "system:backfill",
          nestId,
          doc.id,
        );
      }

      // Tag index is derived from latest version's tags — keep it
      // populated in case the doc was never edited through the
      // governance routes.
      if (tagsJson) {
        const updateTags = db.prepare(
          `UPDATE node_versions SET tags_json = ?
           WHERE nest_id = ? AND node_id = ? AND version = ? AND tags_json IS NULL`,
        );
        updateTags.run(tagsJson, nestId, doc.id, latestVersion);
      }
    }
  }

  db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)").run(
    MIGRATION_ID,
  );

  console.log(
    `[backfill] node_versions: scanned ${totalDocs} docs across ${nests.length} nests, inserted ${totalInserted} rows`,
  );
}
