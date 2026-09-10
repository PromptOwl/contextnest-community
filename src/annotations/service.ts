/**
 * Annotation service — the structured source of truth (SQLite), plus the
 * projection that re-materializes a node's threads into a derived markdown node
 * the nest/MCP already pulls. Deliberately separate from version-service: these
 * rows are never hash-chained.
 */

import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { nowExpr } from "../db/sql.js";
import * as versions from "../governance/version-service.js";
import { engineCache } from "../nodes/engine.js";
import { createNode, updateNode, bodyOnly } from "../nodes/service.js";
import { NotFoundError } from "../shared/errors.js";
import { DERIVED_ANNOTATIONS_SUFFIX } from "../shared/node-id.js";
import { clampAnchor, projectThreadsToMarkdown } from "./projection.js";
import type {
  AnnotationAnchor,
  AnnotationComment,
  AnnotationThread,
  CreateThreadInput,
  ThreadStatus,
} from "./types.js";

interface ThreadRow {
  id: string;
  nest_id: string;
  node_id: string;
  snapshot_version: number | null;
  anchor_json: string | null;
  status: ThreadStatus;
  created_by: string;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

interface CommentRow {
  id: string;
  thread_id: string;
  author: string;
  body: string;
  created_at: string;
}

async function loadComments(threadId: string): Promise<AnnotationComment[]> {
  const db = getDb();
  const rows = await db
    .all(
      "SELECT id, author, body, created_at FROM annotation_comments WHERE thread_id = ? ORDER BY created_at ASC, id ASC",
      [threadId],
    ) as Array<Omit<CommentRow, "thread_id">>;
  return rows.map((r) => ({
    id: r.id,
    author: r.author,
    body: r.body,
    createdAt: r.created_at,
  }));
}

async function rowToThread(row: ThreadRow): Promise<AnnotationThread> {
  let anchor: AnnotationAnchor | null = null;
  if (row.anchor_json) {
    try {
      anchor = JSON.parse(row.anchor_json) as AnnotationAnchor;
    } catch {
      anchor = null;
    }
  }
  return {
    id: row.id,
    nestId: row.nest_id,
    nodeId: row.node_id,
    snapshotVersion: row.snapshot_version,
    anchor,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    comments: await loadComments(row.id),
  };
}

async function getThreadRow(threadId: string): Promise<ThreadRow | undefined> {
  return await getDb()
    .get("SELECT * FROM annotation_threads WHERE id = ?", [threadId]) as ThreadRow | undefined;
}

export async function getThread(threadId: string): Promise<AnnotationThread | null> {
  const row = await getThreadRow(threadId);
  return row ? await rowToThread(row) : null;
}

/**
 * Per-node comment counts for a whole nest — used to sort document lists by
 * "most comments" without N per-node queries. Counts annotation THREADS (each
 * a distinct comment discussion) and the most recent thread time.
 */
export async function countThreadsByNode(
  nestId: string,
): Promise<Record<string, { count: number; lastAt: string | null }>> {
  const rows = (await getDb().all(
    `SELECT node_id, CAST(COUNT(*) AS INTEGER) AS count, MAX(created_at) AS last_at
         FROM annotation_threads
        WHERE nest_id = ?
        GROUP BY node_id`,
    [nestId],
  )) as Array<{ node_id: string; count: number; last_at: string | null }>;
  const out: Record<string, { count: number; lastAt: string | null }> = {};
  for (const r of rows) out[r.node_id] = { count: r.count, lastAt: r.last_at };
  return out;
}

export async function listThreads(nestId: string, nodeId: string): Promise<AnnotationThread[]> {
  const rows = await getDb()
    .all(
      "SELECT * FROM annotation_threads WHERE nest_id = ? AND node_id = ? ORDER BY created_at ASC, id ASC",
      [nestId, nodeId],
    ) as ThreadRow[];
  return Promise.all(rows.map(rowToThread));
}

export async function createThread(
  nestId: string,
  nodeId: string,
  input: CreateThreadInput,
  authorEmail: string,
): Promise<AnnotationThread> {
  const body = (input.body ?? "").trim();
  if (!body) {
    throw new Error("comment body is required");
  }
  const db = getDb();
  const id = uuid();
  const anchor = clampAnchor(input.anchor);
  const snapshot =
    input.snapshotVersion ?? (await versions.getApprovedVersion(nestId, nodeId)) ?? null;

  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO annotation_threads
         (id, nest_id, node_id, snapshot_version, anchor_json, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      [
        id,
        nestId,
        nodeId,
        snapshot,
        anchor ? JSON.stringify(anchor) : null,
        authorEmail,
      ],
    );
    await tx.run(
      "INSERT INTO annotation_comments (id, thread_id, author, body) VALUES (?, ?, ?, ?)",
      [uuid(), id, authorEmail, body],
    );
  });

  return rowToThread((await getThreadRow(id))!);
}

/**
 * Load a thread and assert it belongs to the URL's nest+node. The route only
 * authorizes the URL node via `canReadNode`; without this check a caller with
 * read access to one node could mutate a thread in another nest/node just by
 * knowing its UUID (IDOR). Treat a scope mismatch as not-found so we don't leak
 * the existence of threads the caller can't see.
 */
async function getScopedThreadRow(
  threadId: string,
  nestId: string,
  nodeId: string,
): Promise<ThreadRow> {
  const row = await getThreadRow(threadId);
  if (!row || row.nest_id !== nestId || row.node_id !== nodeId) {
    throw new NotFoundError(`Thread not found: ${threadId}`);
  }
  return row;
}

export async function addComment(
  nestId: string,
  nodeId: string,
  threadId: string,
  authorEmail: string,
  body: string,
): Promise<AnnotationThread> {
  const trimmed = (body ?? "").trim();
  if (!trimmed) {
    throw new Error("comment body is required");
  }
  await getScopedThreadRow(threadId, nestId, nodeId);

  await getDb()
    .run(
      "INSERT INTO annotation_comments (id, thread_id, author, body) VALUES (?, ?, ?, ?)",
      [uuid(), threadId, authorEmail, trimmed],
    );

  return rowToThread((await getThreadRow(threadId))!);
}

export async function setThreadStatus(
  nestId: string,
  nodeId: string,
  threadId: string,
  status: ThreadStatus,
  byEmail: string,
): Promise<AnnotationThread> {
  await getScopedThreadRow(threadId, nestId, nodeId);

  const db = getDb();
  if (status === "resolved") {
    await db.run(
      `UPDATE annotation_threads SET status = 'resolved', resolved_by = ?, resolved_at = ${nowExpr(db)} WHERE id = ?`,
      [byEmail, threadId],
    );
  } else {
    await db.run(
      "UPDATE annotation_threads SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ?",
      [threadId],
    );
  }
  return rowToThread((await getThreadRow(threadId))!);
}

/**
 * Read a hosted artifact's HTML body + title for a *frozen snapshot*.
 *
 * Resolution order for which snapshot to serve:
 *   1. explicit `version` (the snapshot a viewer/annotation is pinned to),
 *   2. else the node's approved version,
 *   3. else the live on-disk body (un-versioned / ungoverned fallback).
 *
 * A specific version is materialized via the engine's `reconstructVersion`
 * (the same path public LLM reads use) so the served HTML never drifts from
 * what annotations were anchored against — this is the frozen-snapshot
 * guarantee, NOT a live link. Returns the resolved `version` so the caller can
 * pin newly created threads to it, plus the node `type` for kind enforcement.
 */
/**
 * The node id a hosted-artifact URL addresses.
 *
 * The route is mounted under `/nests/:id/nodes`, and a structured nest's ids
 * already start with `nodes/` — so the honest URL for one names the segment
 * once (`…/nodes/<slug>/hosted`), and the doubled form keeps working too.
 *
 * Which layout the nest uses is already recorded (`is_imported`), so the
 * likely id is formed rather than probed: this runs on every artifact view,
 * and guessing wrong the other way meant a read that always failed before the
 * real one. Storage is only consulted when the first form turns out to be
 * wrong — an imported vault that happens to keep its documents under nodes/.
 */
export async function resolveHostedNodeId(
  nestId: string,
  nodeId: string,
): Promise<string> {
  if (nodeId.startsWith("nodes/")) return nodeId;
  const row = (await getDb().get(
    "SELECT is_imported FROM nests WHERE id = ?",
    [nestId],
  )) as { is_imported?: number } | undefined;
  if (!row?.is_imported) return `nodes/${nodeId}`;

  const { storage } = await engineCache.get(nestId);
  try {
    await storage.readDocument(nodeId);
    return nodeId;
  } catch {
    return `nodes/${nodeId}`;
  }
}

export async function readArtifact(
  nestId: string,
  nodeId: string,
  version?: number | null,
): Promise<{
  title: string;
  html: string;
  version: number | null;
  type: string | null;
}> {
  const { storage, versions: versionManager } = await engineCache.get(nestId);

  const target =
    version ?? (await versions.getApprovedVersion(nestId, nodeId)) ?? null;

  // Title/type + live body from the on-disk doc (cheap, stable label). Missing
  // doc is only fatal when we also have no snapshot to fall back on.
  let title = nodeId;
  let type: string | null = null;
  let liveHtml = "";
  let liveExists = true;
  try {
    const node = await storage.readDocument(nodeId);
    title = node.frontmatter?.title || nodeId;
    type = (node.frontmatter?.type as string) || null;
    liveHtml = node.body || "";
  } catch {
    liveExists = false;
  }

  if (target != null) {
    try {
      const raw = await versionManager.reconstructVersion(nodeId, target);
      return { title, html: bodyOnly(nodeId, raw), version: target, type };
    } catch (err) {
      console.warn(
        `[annotations] reconstruct v${target} failed for ${nestId}/${nodeId}; falling back to live body:`,
        err,
      );
    }
  }

  if (!liveExists) {
    throw new NotFoundError(`Artifact not found: ${nodeId}`);
  }
  return { title, html: liveHtml, version: target, type };
}

/**
 * Deterministic id for an artifact's derived annotations node, keyed off the
 * SOURCE node id (unique within the nest) — NOT its human-readable title. This
 * avoids two failure modes: (a) collisions when two artifacts have titles that
 * slug to the same value, and (b) silent duplicate nodes if the node-service
 * title→slug algorithm ever changes. Passed as an explicit id to createNode so
 * create and update agree on the same id forever.
 */
export function derivedAnnotationsId(sourceNodeId: string): string {
  const base = sourceNodeId.replace(/^nodes\//, "");
  return `nodes/${base}${DERIVED_ANNOTATIONS_SUFFIX}`;
}

/**
 * Re-project a node's threads into a derived markdown node so the existing
 * MCP/context assembly pulls the feedback into the next iteration.
 *
 * Best-effort: a projection failure must never fail the underlying comment
 * mutation (the thread is already persisted).
 */
export async function syncAnnotationsNode(
  nestId: string,
  nodeId: string,
  userEmail: string,
): Promise<void> {
  try {
    let title = nodeId;
    let type: string | null = null;
    try {
      const { storage } = await engineCache.get(nestId);
      const node = await storage.readDocument(nodeId);
      title = node.frontmatter?.title || nodeId;
      type = (node.frontmatter?.type as string) || "document";
    } catch {
      /* artifact gone — still project an empty/placeholder doc */
    }

    // Only artifacts feed the regen/MCP loop through a derived node — an agent
    // regenerates the artifact from this feedback. Plain documents keep their
    // comments in SQLite only: no derived `— Annotations` node (which would
    // itself be annotatable → recursion, and clutter the nest). A failed read
    // (type === null) is a deleted node — fall through so any existing derived
    // node still gets its placeholder refresh.
    if (type !== null && type !== "artifact") return;

    const threads = await listThreads(nestId, nodeId);
    // Bound the source title so the suffix can't push this past the node
    // service's title cap. createNode would throw into the outer best-effort
    // catch and the projection would silently stop being created — and source
    // titles predating the cap are arbitrarily long. Cosmetic only: the
    // derived id keys off the source node id, not this string.
    const derivedTitle = `${title.slice(0, 100)} — Annotations`;
    const markdown = projectThreadsToMarkdown(title, threads);
    const derivedId = derivedAnnotationsId(nodeId);

    try {
      await updateNode(nestId, derivedId, { content: markdown }, userEmail);
    } catch (err) {
      if (err instanceof NotFoundError) {
        await createNode(
          nestId,
          {
            id: derivedId,
            title: derivedTitle,
            content: markdown,
            type: "document",
            tags: ["annotations"],
          },
          userEmail,
        );
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.warn(
      `[annotations] failed to sync derived node for ${nestId}/${nodeId}:`,
      err,
    );
  }
}
