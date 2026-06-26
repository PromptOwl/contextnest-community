/**
 * Comment Service — standalone collaboration comments (CU-wdqcpzudt3).
 *
 * Comments are deliberately NOT part of the engine version/hash chain. They
 * are plain SQLite rows (see migration 010) that live *alongside* a node:
 * threaded, attributed, anchored to a highlight span, and resolvable — the
 * "Comments" half of Word's Comments + Track Changes (Track Changes already
 * ships as the suggestion/review services).
 *
 * This service also assembles the per-node / per-nest activity log by
 * aggregating actor + timestamp fields that already exist on comments,
 * node_versions, and review_requests — a read-only view, no new write path.
 */

import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { listNestExternalEdits } from "./external-edit-service.js";
import type { Comment, CommentStatus, ActivityEntry } from "./types.js";

// ─── Create ─────────────────────────────────────────────────────────────

export function createComment(params: {
  nestId: string;
  nodeId: string;
  author: string;
  body: string;
  version?: number;
  anchor?: { start: number; end: number; text?: string };
  parentId?: string;
}): Comment {
  const db = getDb();

  const body = (params.body ?? "").trim();
  if (!body) {
    throw new Error("Comment body is required");
  }

  // A reply must point at a real comment on the same node — otherwise the
  // thread would dangle (or cross-link two documents).
  if (params.parentId) {
    const parent = db
      .prepare(
        "SELECT id FROM comments WHERE id = ? AND nest_id = ? AND node_id = ?",
      )
      .get(params.parentId, params.nestId, params.nodeId) as
      | { id: string }
      | undefined;
    if (!parent) {
      throw new Error("Parent comment not found on this node");
    }
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO comments
       (id, nest_id, node_id, version, anchor_start, anchor_end, anchor_text,
        parent_id, author, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.nestId,
    params.nodeId,
    params.version ?? null,
    params.anchor?.start ?? null,
    params.anchor?.end ?? null,
    params.anchor?.text ?? null,
    params.parentId ?? null,
    params.author,
    body,
  );

  return getComment(id)!;
}

// ─── List ───────────────────────────────────────────────────────────────

export function listComments(
  nestId: string,
  nodeId: string,
  opts: { status?: CommentStatus } = {},
): Comment[] {
  const db = getDb();
  const args: any[] = [nestId, nodeId];
  let statusClause = "";
  if (opts.status) {
    statusClause = " AND status = ?";
    args.push(opts.status);
  }
  // Chronological so the UI can fold replies under their parent in order.
  const rows = db
    .prepare(
      `SELECT * FROM comments
        WHERE nest_id = ? AND node_id = ?${statusClause}
        ORDER BY created_at ASC`,
    )
    .all(...args) as any[];
  return rows.map(rowToComment);
}

export function getComment(id: string): Comment | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as any;
  return row ? rowToComment(row) : null;
}

// ─── Resolve ────────────────────────────────────────────────────────────

export function resolveComment(params: {
  nestId: string;
  commentId: string;
  resolvedBy: string;
}): Comment {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM comments WHERE id = ? AND nest_id = ?")
    .get(params.commentId, params.nestId) as { id: string } | undefined;
  if (!existing) {
    throw new Error("Comment not found");
  }
  db.prepare(
    `UPDATE comments
        SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now')
      WHERE id = ?`,
  ).run(params.resolvedBy, params.commentId);
  return getComment(params.commentId)!;
}

// ─── Activity log ───────────────────────────────────────────────────────
// "Who did what" for a node (or a whole nest) — a read-only aggregation over
// comments + node_versions + review_requests, plus the pending external-edit
// suggestions (which live on disk, not SQLite). No new storage; we just project
// the actor/timestamp fields each source already records.
//
// Async because pending suggestions are read from nest storage on disk
// (external-edit-service), not the database.

export async function getActivity(params: {
  nestId: string;
  nodeId?: string;
  limit?: number;
}): Promise<ActivityEntry[]> {
  const db = getDb();
  const limit = params.limit ?? 100;
  const entries: ActivityEntry[] = [];

  const nodeFilter = params.nodeId ? " AND node_id = ?" : "";
  const baseArgs: any[] = params.nodeId
    ? [params.nestId, params.nodeId]
    : [params.nestId];

  // Comments — both the leaving and the resolving are events.
  const commentRows = db
    .prepare(
      `SELECT id, node_id, author, body, status, created_at, resolved_by, resolved_at
         FROM comments
        WHERE nest_id = ?${nodeFilter}`,
    )
    .all(...baseArgs) as any[];
  for (const r of commentRows) {
    entries.push({
      type: "comment",
      nodeId: r.node_id,
      actor: r.author,
      at: r.created_at,
      detail: excerpt(r.body),
      refId: r.id,
    });
    if (r.status === "resolved" && r.resolved_by && r.resolved_at) {
      entries.push({
        type: "comment_resolved",
        nodeId: r.node_id,
        actor: r.resolved_by,
        at: r.resolved_at,
        detail: excerpt(r.body),
        refId: r.id,
      });
    }
  }

  // Edits — every node_versions row is an edit by its author.
  const versionRows = db
    .prepare(
      `SELECT node_id, version, author, change_note, created_at
         FROM node_versions
        WHERE nest_id = ?${nodeFilter}`,
    )
    .all(...baseArgs) as any[];
  for (const r of versionRows) {
    entries.push({
      type: "edit",
      nodeId: r.node_id,
      actor: r.author,
      at: r.created_at,
      detail: r.change_note || `v${r.version}`,
      refId: String(r.version),
    });
  }

  // Reviews — request + resolution are distinct events.
  const reviewRows = db
    .prepare(
      `SELECT id, node_id, requested_by, requested_at, status, resolved_by, resolved_at
         FROM review_requests
        WHERE nest_id = ?${nodeFilter}`,
    )
    .all(...baseArgs) as any[];
  for (const r of reviewRows) {
    entries.push({
      type: "review_requested",
      nodeId: r.node_id,
      actor: r.requested_by,
      at: r.requested_at,
      detail: "requested review",
      refId: r.id,
    });
    if (r.resolved_by && r.resolved_at) {
      entries.push({
        type: "review_resolved",
        nodeId: r.node_id,
        actor: r.resolved_by,
        at: r.resolved_at,
        detail: r.status, // approved | rejected | cancelled
        refId: r.id,
      });
    }
  }

  // Proposed edits — pending external-edit suggestions ("Bob proposed an
  // edit"). These are NOT in SQLite: the engine stages them on disk inside
  // the nest, so we read them through the external-edit service. A storage
  // read failure must not break the rest of the feed, so we degrade to no
  // suggestions rather than throwing.
  try {
    const pending = await listNestExternalEdits(params.nestId);
    for (const e of pending) {
      // document_id is the node id; honour the per-node filter.
      if (params.nodeId && e.document_id !== params.nodeId) continue;
      entries.push({
        type: "edit_proposed",
        nodeId: e.document_id,
        actor: e.actor,
        at: e.detected_at,
        detail: e.note || `proposed an edit (${e.source})`,
        refId: e.suggestion_id,
      });
    }
  } catch (err) {
    console.error(
      `[comments] failed to load pending external edits for activity feed (nest ${params.nestId}):`,
      err,
    );
  }

  // Newest first, capped.
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return entries.slice(0, limit);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function excerpt(body: string, max = 80): string {
  const s = (body || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function rowToComment(row: any): Comment {
  const anchor =
    row.anchor_start !== null && row.anchor_end !== null
      ? {
          start: row.anchor_start,
          end: row.anchor_end,
          ...(row.anchor_text !== null ? { text: row.anchor_text } : {}),
        }
      : undefined;
  return {
    id: row.id,
    nestId: row.nest_id,
    nodeId: row.node_id,
    version: row.version ?? undefined,
    anchor,
    parentId: row.parent_id ?? undefined,
    author: row.author,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
  };
}
