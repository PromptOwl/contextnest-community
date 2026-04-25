/**
 * Tag Index Service — node→tag mapping for fast steward resolution.
 *
 * The resolver joins against `node_tag_index` instead of scanning
 * `node_versions.tags_json`. Single source of truth for tag normalization:
 * strip leading `#`, trim, lowercase.
 */

import { getDb } from "../db/client.js";
import { engineCache } from "../nodes/engine.js";

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, "").toLowerCase();
}

/**
 * Replace the tag set for a node. Idempotent.
 * Pass an empty array to clear.
 */
export function syncNodeTags(
  nestId: string,
  nodeId: string,
  tags: string[],
): void {
  const db = getDb();
  const normalized = Array.from(
    new Set(
      tags
        .filter((t): t is string => typeof t === "string")
        .map(normalizeTag)
        .filter(Boolean),
    ),
  );

  db.transaction(() => {
    db.prepare(
      "DELETE FROM node_tag_index WHERE nest_id = ? AND node_id = ?",
    ).run(nestId, nodeId);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO node_tag_index (nest_id, node_id, tag_name) VALUES (?, ?, ?)",
    );
    for (const tag of normalized) {
      insert.run(nestId, nodeId, tag);
    }
  })();
}

export function getTagsForNode(nestId: string, nodeId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT tag_name FROM node_tag_index WHERE nest_id = ? AND node_id = ? ORDER BY tag_name",
    )
    .all(nestId, nodeId) as Array<{ tag_name: string }>;
  return rows.map((r) => r.tag_name);
}

export function removeNodeFromTagIndex(
  nestId: string,
  nodeId: string,
): void {
  const db = getDb();
  db.prepare(
    "DELETE FROM node_tag_index WHERE nest_id = ? AND node_id = ?",
  ).run(nestId, nodeId);
}

/**
 * Full rescan: walk the nest's disk vault, read every frontmatter,
 * and rebuild the index. Idempotent. Expected to be slow on large vaults.
 */
export async function rebuildTagIndex(nestId: string): Promise<number> {
  const { storage } = engineCache.get(nestId);
  const documents = await storage.discoverDocuments();
  const db = getDb();

  db.transaction(() => {
    db.prepare("DELETE FROM node_tag_index WHERE nest_id = ?").run(nestId);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO node_tag_index (nest_id, node_id, tag_name) VALUES (?, ?, ?)",
    );
    for (const doc of documents) {
      const tags = (doc.frontmatter.tags || [])
        .map(normalizeTag)
        .filter(Boolean);
      for (const tag of tags) {
        insert.run(nestId, doc.id, tag);
      }
    }
  })();

  return documents.length;
}
