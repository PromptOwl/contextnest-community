/**
 * Node Index — the nest's document list, in the database.
 *
 * Document existence, id, title, type, status, tags and `updated_at` live only
 * on disk, so every listing used to re-walk the vault and parse every markdown
 * file in it. Locally that is a page-cache hit; on a Cloud Storage mount it is
 * one network round trip per file, repeated on every mount — which is the
 * whole of the localhost-fast / cloud-slow gap, since the in-process discovery
 * cache in engine.ts dies with the instance.
 *
 * Disk stays the source of truth. This table is a derived mirror:
 *   - written through on every document write (see withDiscoveryCache in
 *     engine.ts — the one place every mutation funnels through), and
 *   - rebuilt from disk whenever the nest is marked stale, which is what any
 *     write we could not mirror, any out-of-band edit, and any fresh upgrade
 *     leave behind.
 *
 * Nothing here parses INDEX.md. Those files are write-only — the engine
 * regenerates them for humans and browsing agents and never reads them back —
 * so this mirrors the same information from the same source they are built
 * from: `discoverDocuments()`.
 */

import type { ContextNode } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { insertOrIgnore, insertOrReplace, nowExpr } from "../db/sql.js";
import type { Querier, SqlParam } from "../db/adapter.js";
import { folderOfId } from "../shared/node-id.js";

/** A stored row, before it is rehydrated into a ContextNode. */
interface IndexRow {
  node_id: string;
  frontmatter_json: string;
}

const INSERT_COLS =
  "(nest_id, node_id, folder, title, type, status, updated_at, frontmatter_json)";
const INSERT_VALUES = "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
/** Postgres upsert body — mirrors SQLite's INSERT OR REPLACE full-row swap. */
const UPSERT_SET = [
  "folder = excluded.folder",
  "title = excluded.title",
  "type = excluded.type",
  "status = excluded.status",
  "updated_at = excluded.updated_at",
  "frontmatter_json = excluded.frontmatter_json",
].join(", ");

/** The column values for one document, in INSERT_COLS order after nest_id. */
function rowValues(node: ContextNode): SqlParam[] {
  const fm = node.frontmatter;
  return [
    node.id,
    folderOfId(node.id),
    fm.title === undefined || fm.title === null ? "" : String(fm.title),
    fm.type || "document",
    (fm.status as string) || "draft",
    fm.updated_at ?? null,
    JSON.stringify(fm ?? {}),
  ];
}

/** Rehydrate a row into the shape every listing consumer already speaks. */
function toNode(row: IndexRow): ContextNode {
  return {
    id: row.node_id,
    filePath: "",
    rawContent: "",
    // A row written by this process is always valid JSON; a hand-edited or
    // half-written one must not take the whole listing down with it.
    frontmatter: safeParse(row.frontmatter_json),
    body: "",
  } as ContextNode;
}

function safeParse(json: string): ContextNode["frontmatter"] {
  try {
    return JSON.parse(json);
  } catch {
    return {} as ContextNode["frontmatter"];
  }
}

/**
 * Mirror one written document, or drop its row when `node` is null (deleted).
 *
 * Called from the write path, so it must never throw: a failed mirror marks
 * the nest stale instead, and the next read rebuilds before answering.
 */
export async function syncIndexedNode(
  nestId: string,
  nodeId: string,
  node: ContextNode | null,
): Promise<void> {
  // Before the write, so a rebuild that crawled disk earlier and finishes
  // later sees the bump and refuses to stamp over it (see rebuildNodeIndex).
  writeGeneration.set(nestId, (writeGeneration.get(nestId) ?? 0) + 1);
  try {
    const db = getDb();
    if (!node) {
      await db.run(
        "DELETE FROM node_index WHERE nest_id = ? AND node_id = ?",
        [nestId, nodeId],
      );
      return;
    }
    await db.run(
      insertOrReplace(
        db,
        `INSERT INTO node_index ${INSERT_COLS} ${INSERT_VALUES}`,
        ["nest_id", "node_id"],
        UPSERT_SET,
      ),
      [nestId, ...rowValues(node)],
    );
  } catch (err) {
    console.error("[node-index] sync failed, marking stale", nestId, nodeId, err);
    await markIndexStale(nestId);
  }
}

/**
 * Flag a nest for a full rebuild on next read.
 *
 * The honest response to "we no longer know that the mirror matches disk":
 * an out-of-band edit, an import, a write we could not mirror. Never throws —
 * it is called from `finally` blocks on the write path.
 */
export async function markIndexStale(nestId: string): Promise<void> {
  try {
    await getDb().run(
      "UPDATE nests SET index_synced_at = NULL WHERE id = ?",
      [nestId],
    );
  } catch (err) {
    console.error("[node-index] could not mark stale", nestId, err);
  }
}

/**
 * One rebuild per nest at a time. A cold nest is hit by several concurrent
 * requests on first paint (listing + census + folders), and without this each
 * would run its own full crawl of the same vault.
 */
const rebuilds = new Map<string, Promise<void>>();

/**
 * Bumped on every mirrored write, so a rebuild can tell whether the vault
 * moved under it between the crawl and the row swap. Same guard the discovery
 * cache in engine.ts uses against the same shape of race.
 */
const writeGeneration = new Map<string, number>();

/**
 * Guarantee the mirror is usable before a read, rebuilding it from disk when
 * the nest is stale. A no-op — one indexed lookup — once warm.
 */
export async function ensureNodeIndex(nestId: string): Promise<void> {
  const row = (await getDb().get(
    "SELECT index_synced_at FROM nests WHERE id = ?",
    [nestId],
  )) as { index_synced_at?: string | null } | undefined;
  // No nest row at all: not this module's error to raise — the caller's own
  // lookup reports it. A stamped nest is warm and needs nothing.
  if (!row || row.index_synced_at) return;

  const inflight = rebuilds.get(nestId);
  if (inflight) return inflight;

  const run: Promise<void> = rebuildNodeIndex(nestId)
    .then(() => undefined)
    .catch((err) => {
      // Leave the nest stale so the next read retries rather than serving a
      // half-built mirror. Reads still succeed — on whatever is in the table.
      console.error("[node-index] rebuild failed", nestId, err);
    })
    .finally(() => {
      if (rebuilds.get(nestId) === run) rebuilds.delete(nestId);
    });
  rebuilds.set(nestId, run);
  return run;
}

/**
 * Full rescan: crawl the vault once and replace every row for the nest.
 *
 * Delete-then-insert in one transaction, the same shape as rebuildTagIndex —
 * a document removed on disk has to leave the mirror too, which an upsert-only
 * pass would miss. Returns the number of documents indexed.
 */
export async function rebuildNodeIndex(nestId: string): Promise<number> {
  // Imported lazily: engine.ts writes through to this module, and a static
  // import back into it would close the cycle at module-evaluation time.
  const { engineCache } = await import("./engine.js");
  const { documentsWithSuggestions } = await import(
    "../governance/external-edit-service.js"
  );
  const { storage, dropDiscoveryCache } = await engineCache.get(nestId);
  // A rebuild exists to reconcile with what is actually on disk — a write
  // another instance made, an edit from outside the app — so the memoized
  // document set is exactly the thing that must not answer. The memory-only
  // invalidator, not invalidateDiscovery: the latter would flag the nest stale
  // again and undo the stamp this rebuild is about to write.
  dropDiscoveryCache();
  const startedAt = writeGeneration.get(nestId) ?? 0;
  const documents = await storage.discoverDocuments({ includeRetired: true });
  // The one place the whole-vault suggestion walk still runs: once per rebuild,
  // reconciling the badge flags against disk, instead of once per listing.
  const staged = await documentsWithSuggestions(nestId);

  const db = getDb();
  const insertSql = insertOrReplace(
    db,
    `INSERT INTO node_index ${INSERT_COLS} ${INSERT_VALUES}`,
    ["nest_id", "node_id"],
    UPSERT_SET,
  );
  const stagedSql = insertOrIgnore(
    db,
    "INSERT INTO node_suggestions (nest_id, node_id) VALUES (?, ?)",
  );
  await db.transaction(async (tx: Querier) => {
    await tx.run("DELETE FROM node_index WHERE nest_id = ?", [nestId]);
    for (const doc of documents) {
      await tx.run(insertSql, [nestId, ...rowValues(doc)]);
    }
    await tx.run("DELETE FROM node_suggestions WHERE nest_id = ?", [nestId]);
    for (const id of staged) {
      await tx.run(stagedSql, [nestId, id]);
    }
    // Stamped inside the transaction: a crash between the rows and the stamp
    // would otherwise leave a complete mirror flagged stale forever, or —
    // worse the other way round — an empty one flagged fresh.
    //
    // Unless a write landed while this rebuild was crawling. The row swap above
    // replaces EVERY row for the nest with the set read before that write, so
    // stamping now would publish a mirror that denies a document actually on
    // disk. Leaving it stale costs one more crawl on the next read; the
    // alternative loses the document until something else flags the nest.
    if ((writeGeneration.get(nestId) ?? 0) !== startedAt) return;
    await tx.run(
      `UPDATE nests SET index_synced_at = ${nowExpr(db)} WHERE id = ?`,
      [nestId],
    );
  });

  return documents.length;
}

/**
 * Record (or clear) the fact that a document has an external edit staged.
 *
 * Called from the three points that stage, approve or reject a suggestion.
 * Never throws — a wrong badge must not fail a governance write, and the next
 * rebuild reconciles the whole nest against disk anyway.
 */
export async function setSuggestionFlag(
  nestId: string,
  nodeId: string,
  present: boolean,
): Promise<void> {
  try {
    const db = getDb();
    if (!present) {
      await db.run(
        "DELETE FROM node_suggestions WHERE nest_id = ? AND node_id = ?",
        [nestId, nodeId],
      );
      return;
    }
    await db.run(
      insertOrIgnore(
        db,
        "INSERT INTO node_suggestions (nest_id, node_id) VALUES (?, ?)",
      ),
      [nestId, nodeId],
    );
  } catch (err) {
    console.error("[node-index] suggestion flag failed", nestId, nodeId, err);
  }
}

/**
 * The documents in this nest with an external edit staged.
 *
 * The DB twin of `documentsWithSuggestions`, which answers the same question
 * by walking the whole vault — including one `.versions/<doc>/` directory per
 * document — and did so on EVERY listing request, for a condition that is
 * empty on almost every row.
 */
export async function nodesWithSuggestions(
  nestId: string,
): Promise<Set<string>> {
  const rows = (await getDb().all(
    "SELECT node_id FROM node_suggestions WHERE nest_id = ?",
    [nestId],
  )) as Array<{ node_id: string }>;
  return new Set(rows.map((r) => r.node_id));
}

/**
 * The nest's documents, from the mirror. Frontmatter only — no bodies, which
 * is the point: a body costs a file read and the listing never renders one.
 *
 * Only `folder` narrows in SQL. Type/tag/status filtering stays with the
 * engine's own `filterDocuments`, so this surface cannot drift from the CLI
 * and mcp-server on what `type: document`, a `#`-less tag, or a status alias
 * means — the same reason the listing ran through `context_list` before.
 *
 * Ordered by id, matching what discovery returns, so callers that assumed a
 * sorted set keep getting one.
 */
/**
 * Just the node ids this nest has indexed.
 *
 * For callers that already hold the on-disk set and want to know whether the
 * mirror still describes the same documents — cheaper than rehydrating every
 * row's frontmatter to answer a membership question.
 */
export async function indexedNodeIds(nestId: string): Promise<Set<string>> {
  const rows = (await getDb().all(
    "SELECT node_id FROM node_index WHERE nest_id = ?",
    [nestId],
  )) as Array<{ node_id: string }>;
  return new Set(rows.map((r) => r.node_id));
}

export async function readIndexedNodes(
  nestId: string,
  filters: { folder?: string } = {},
): Promise<ContextNode[]> {
  const where = ["nest_id = ?"];
  const params: SqlParam[] = [nestId];
  if (filters.folder !== undefined) {
    where.push("folder = ?");
    params.push(filters.folder);
  }
  const rows = (await getDb().all(
    `SELECT node_id, frontmatter_json FROM node_index
      WHERE ${where.join(" AND ")}
      ORDER BY node_id`,
    params,
  )) as IndexRow[];
  return rows.map(toNode);
}

/**
 * Direct document count per folder, for the navigable tree.
 *
 * Folders holding only subfolders have no row of their own, so the caller
 * still has to synthesise the missing ancestors — same as the census does.
 */
export async function indexedFolderCounts(
  nestId: string,
): Promise<Array<{ path: string; count: number }>> {
  const rows = (await getDb().all(
    `SELECT folder, COUNT(*) AS count FROM node_index
      WHERE nest_id = ? AND folder <> ''
      GROUP BY folder`,
    [nestId],
  )) as Array<{ folder: string; count: number | string }>;
  return rows.map((r) => ({ path: r.folder, count: Number(r.count) }));
}
