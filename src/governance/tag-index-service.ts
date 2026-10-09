/**
 * Tag Index Service — node→tag mapping for fast steward resolution.
 *
 * The resolver joins against `node_tag_index` instead of scanning
 * `node_versions.tags_json`. Single source of truth for tag normalization:
 * strip leading `#`, trim, lowercase.
 */

import { getDb } from "../db/client.js";
import { insertOrIgnore } from "../db/sql.js";
import { engineCache } from "../nodes/engine.js";

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, "").toLowerCase();
}

function normalizeTagSet(tags: string[]): string[] {
  return Array.from(
    new Set(
      tags
        .filter((t): t is string => typeof t === "string")
        .map(normalizeTag)
        .filter(Boolean),
    ),
  );
}

/**
 * Replace the tag set for a node. Idempotent.
 * Pass an empty array to clear.
 */
export async function syncNodeTags(
  nestId: string,
  nodeId: string,
  tags: string[],
): Promise<void> {
  const db = getDb();
  const normalized = normalizeTagSet(tags);

  const insertSql = insertOrIgnore(
    db,
    "INSERT INTO node_tag_index (nest_id, node_id, tag_name) VALUES (?, ?, ?)",
  );
  await db.transaction(async (tx) => {
    await tx.run(
      "DELETE FROM node_tag_index WHERE nest_id = ? AND node_id = ?",
      [nestId, nodeId],
    );
    for (const tag of normalized) {
      await tx.run(insertSql, [nestId, nodeId, tag]);
    }
  });
}

/** `syncNodeTags` for many nodes of one nest in one transaction, multi-row. */
export async function syncNodeTagsMany(
  nestId: string,
  entries: Array<{ nodeId: string; tags: string[] }>,
): Promise<void> {
  if (!entries.length) return;
  const db = getDb();
  const rows = entries.flatMap(({ nodeId, tags }) =>
    normalizeTagSet(tags).map((tag) => [nestId, nodeId, tag]),
  );
  const CHUNK = 200;
  await db.transaction(async (tx) => {
    for (let i = 0; i < entries.length; i += CHUNK) {
      const ids = entries.slice(i, i + CHUNK).map((e) => e.nodeId);
      await tx.run(
        `DELETE FROM node_tag_index WHERE nest_id = ? AND node_id IN (${ids.map(() => "?").join(", ")})`,
        [nestId, ...ids],
      );
    }
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await tx.run(
        insertOrIgnore(
          db,
          `INSERT INTO node_tag_index (nest_id, node_id, tag_name) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`,
        ),
        chunk.flat(),
      );
    }
  });
}

export async function getTagsForNode(
  nestId: string,
  nodeId: string,
): Promise<string[]> {
  const db = getDb();
  const rows = (await db.all(
    "SELECT tag_name FROM node_tag_index WHERE nest_id = ? AND node_id = ? ORDER BY tag_name",
    [nestId, nodeId],
  )) as Array<{ tag_name: string }>;
  return rows.map((r) => r.tag_name);
}

export async function removeNodeFromTagIndex(
  nestId: string,
  nodeId: string,
): Promise<void> {
  const db = getDb();
  await db.run(
    "DELETE FROM node_tag_index WHERE nest_id = ? AND node_id = ?",
    [nestId, nodeId],
  );
}

/**
 * Full rescan: walk the nest's disk vault, read every frontmatter,
 * and rebuild the index. Idempotent. Expected to be slow on large vaults.
 */
export async function rebuildTagIndex(nestId: string): Promise<number> {
  const { storage } = await engineCache.get(nestId);
  const documents = await storage.discoverDocuments();
  const db = getDb();

  const insertSql = insertOrIgnore(
    db,
    "INSERT INTO node_tag_index (nest_id, node_id, tag_name) VALUES (?, ?, ?)",
  );
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM node_tag_index WHERE nest_id = ?", [nestId]);
    for (const doc of documents) {
      const tags = (doc.frontmatter.tags || [])
        .map(normalizeTag)
        .filter(Boolean);
      for (const tag of tags) {
        await tx.run(insertSql, [nestId, doc.id, tag]);
      }
    }
  });

  return documents.length;
}
