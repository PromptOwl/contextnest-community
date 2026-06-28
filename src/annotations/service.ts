/**
 * Annotation service — the structured source of truth (SQLite), plus the
 * projection that re-materializes a node's threads into a derived markdown node
 * the nest/MCP already pulls. Deliberately separate from version-service: these
 * rows are never hash-chained.
 */

import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import * as versions from "../governance/version-service.js";
import { engineCache } from "../nodes/engine.js";
import { createNode, updateNode, bodyOnly } from "../nodes/service.js";
import { NotFoundError } from "../shared/errors.js";
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

function loadComments(threadId: string): AnnotationComment[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, author, body, created_at FROM annotation_comments WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(threadId) as Array<Omit<CommentRow, "thread_id">>;
  return rows.map((r) => ({
    id: r.id,
    author: r.author,
    body: r.body,
    createdAt: r.created_at,
  }));
}

function rowToThread(row: ThreadRow): AnnotationThread {
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
    comments: loadComments(row.id),
  };
}

function getThreadRow(threadId: string): ThreadRow | undefined {
  return getDb()
    .prepare("SELECT * FROM annotation_threads WHERE id = ?")
    .get(threadId) as ThreadRow | undefined;
}

export function getThread(threadId: string): AnnotationThread | null {
  const row = getThreadRow(threadId);
  return row ? rowToThread(row) : null;
}

export function listThreads(nestId: string, nodeId: string): AnnotationThread[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM annotation_threads WHERE nest_id = ? AND node_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(nestId, nodeId) as ThreadRow[];
  return rows.map(rowToThread);
}

export function createThread(
  nestId: string,
  nodeId: string,
  input: CreateThreadInput,
  authorEmail: string,
): AnnotationThread {
  const body = (input.body ?? "").trim();
  if (!body) {
    throw new Error("comment body is required");
  }
  const db = getDb();
  const id = uuid();
  const anchor = clampAnchor(input.anchor);
  const snapshot =
    input.snapshotVersion ?? versions.getApprovedVersion(nestId, nodeId) ?? null;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO annotation_threads
         (id, nest_id, node_id, snapshot_version, anchor_json, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    ).run(
      id,
      nestId,
      nodeId,
      snapshot,
      anchor ? JSON.stringify(anchor) : null,
      authorEmail,
    );
    db.prepare(
      "INSERT INTO annotation_comments (id, thread_id, author, body) VALUES (?, ?, ?, ?)",
    ).run(uuid(), id, authorEmail, body);
  });
  tx();

  return rowToThread(getThreadRow(id)!);
}

export function addComment(
  threadId: string,
  authorEmail: string,
  body: string,
): AnnotationThread {
  const trimmed = (body ?? "").trim();
  if (!trimmed) {
    throw new Error("comment body is required");
  }
  const row = getThreadRow(threadId);
  if (!row) throw new NotFoundError(`Thread not found: ${threadId}`);

  getDb()
    .prepare(
      "INSERT INTO annotation_comments (id, thread_id, author, body) VALUES (?, ?, ?, ?)",
    )
    .run(uuid(), threadId, authorEmail, trimmed);

  return rowToThread(getThreadRow(threadId)!);
}

export function setThreadStatus(
  threadId: string,
  status: ThreadStatus,
  byEmail: string,
): AnnotationThread {
  const row = getThreadRow(threadId);
  if (!row) throw new NotFoundError(`Thread not found: ${threadId}`);

  if (status === "resolved") {
    getDb()
      .prepare(
        "UPDATE annotation_threads SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?",
      )
      .run(byEmail, threadId);
  } else {
    getDb()
      .prepare(
        "UPDATE annotation_threads SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ?",
      )
      .run(threadId);
  }
  return rowToThread(getThreadRow(threadId)!);
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
  const { storage, versions: versionManager } = engineCache.get(nestId);

  const target =
    version ?? versions.getApprovedVersion(nestId, nodeId) ?? null;

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

/** Slug used by node service when deriving an id from a title. Mirror it so the
 * derived annotations node has a deterministic, upsert-able id. */
function slugId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `nodes/${slug}`;
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
    try {
      const { storage } = engineCache.get(nestId);
      const node = await storage.readDocument(nodeId);
      title = node.frontmatter?.title || nodeId;
    } catch {
      /* artifact gone — still project an empty/placeholder doc */
    }

    const threads = listThreads(nestId, nodeId);
    const derivedTitle = `${title} — Annotations`;
    const markdown = projectThreadsToMarkdown(title, threads);
    const derivedId = slugId(derivedTitle);

    try {
      await updateNode(nestId, derivedId, { content: markdown }, userEmail);
    } catch (err) {
      if (err instanceof NotFoundError) {
        await createNode(
          nestId,
          {
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
