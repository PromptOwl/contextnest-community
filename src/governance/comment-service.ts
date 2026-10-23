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
import { nowExpr } from "../db/sql.js";
import { listNestExternalEdits } from "./external-edit-service.js";
import { describeTaskActivity, listTaskActivity } from "../nodes/task-activity.js";
import type { Comment, CommentStatus, ActivityEntry } from "./types.js";

// ─── Create ─────────────────────────────────────────────────────────────

export async function createComment(params: {
  nestId: string;
  nodeId: string;
  author: string;
  body: string;
  version?: number;
  anchor?: { start?: number; end?: number; text?: string };
  parentId?: string;
}): Promise<Comment> {
  const db = getDb();

  const body = (params.body ?? "").trim();
  if (!body) {
    throw new Error("Comment body is required");
  }

  // A reply must point at a real comment on the same node — otherwise the
  // thread would dangle (or cross-link two documents).
  if (params.parentId) {
    const parent = await db.get(
      "SELECT id FROM comments WHERE id = ? AND nest_id = ? AND node_id = ?",
      [params.parentId, params.nestId, params.nodeId],
    ) as
      | { id: string }
      | undefined;
    if (!parent) {
      throw new Error("Parent comment not found on this node");
    }
  }

  const id = uuid();
  await db.run(
    `INSERT INTO comments
       (id, nest_id, node_id, version, anchor_start, anchor_end, anchor_text,
        parent_id, author, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ],
  );

  return (await getComment(id))!;
}

// ─── List ───────────────────────────────────────────────────────────────

export async function listComments(
  nestId: string,
  nodeId: string,
  opts: { status?: CommentStatus } = {},
): Promise<Comment[]> {
  const db = getDb();
  const args: any[] = [nestId, nodeId];
  let statusClause = "";
  if (opts.status) {
    statusClause = " AND status = ?";
    args.push(opts.status);
  }
  // Chronological so the UI can fold replies under their parent in order.
  const rows = await db.all(
    `SELECT * FROM comments
        WHERE nest_id = ? AND node_id = ?${statusClause}
        ORDER BY created_at ASC`,
    args,
  ) as any[];
  return rows.map(rowToComment);
}

export async function getComment(id: string): Promise<Comment | null> {
  const db = getDb();
  const row = await db.get("SELECT * FROM comments WHERE id = ?", [id]) as any;
  return row ? rowToComment(row) : null;
}

// ─── Resolve ────────────────────────────────────────────────────────────

export async function resolveComment(params: {
  nestId: string;
  nodeId: string;
  commentId: string;
  resolvedBy: string;
}): Promise<Comment> {
  const db = getDb();
  // Scope the lookup to the node in the URL too — otherwise a nest-read user
  // could resolve a comment on ANY node in the nest (incl. steward-restricted
  // ones) by guessing a commentId, with the route's nodeId silently ignored.
  const existing = await db.get(
    "SELECT id, status FROM comments WHERE id = ? AND nest_id = ? AND node_id = ?",
    [params.commentId, params.nestId, params.nodeId],
  ) as
    | { id: string; status: string }
    | undefined;
  if (!existing) {
    throw new Error("Comment not found");
  }
  // Don't let a re-resolve overwrite the original resolver/timestamp — that
  // would permanently lose who first resolved it.
  if (existing.status === "resolved") {
    throw new Error("Comment is already resolved");
  }
  await db.run(
    `UPDATE comments
        SET status = 'resolved', resolved_by = ?, resolved_at = ${nowExpr(db)}
      WHERE id = ?`,
    [params.resolvedBy, params.commentId],
  );
  return (await getComment(params.commentId))!;
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
  // Guard NaN/garbage (a non-numeric ?limit= reaches here as NaN, and
  // `?? 100` does not catch NaN — slice(0, NaN) would return []).
  const limit =
    Number.isFinite(params.limit) && (params.limit as number) > 0
      ? Math.min(params.limit as number, 1000)
      : 100;
  const entries: ActivityEntry[] = [];

  const nodeFilter = params.nodeId ? " AND node_id = ?" : "";
  const baseArgs: any[] = params.nodeId
    ? [params.nestId, params.nodeId]
    : [params.nestId];

  // Each query is bounded by `ORDER BY <latest event> DESC LIMIT ?` so a busy
  // nest doesn't load every row to return a page. The global newest `limit`
  // entries are a subset of each table's newest `limit` rows, so capping per
  // table is correct (we over-fetch slightly because a row can emit 2 events).

  // Comments — both the leaving and the resolving are events.
  const commentRows = await db.all(
    `SELECT id, node_id, author, body, status, created_at, resolved_by, resolved_at
         FROM comments
        WHERE nest_id = ?${nodeFilter}
        ORDER BY COALESCE(resolved_at, created_at) DESC
        LIMIT ?`,
    [...baseArgs, limit],
  ) as any[];
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
  const versionRows = await db.all(
    `SELECT node_id, version, author, change_note, created_at
         FROM node_versions
        WHERE nest_id = ?${nodeFilter}
        ORDER BY created_at DESC
        LIMIT ?`,
    [...baseArgs, limit],
  ) as any[];
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
  const reviewRows = await db.all(
    `SELECT id, node_id, requested_by, requested_at, status, resolved_by, resolved_at
         FROM review_requests
        WHERE nest_id = ?${nodeFilter}
        ORDER BY COALESCE(resolved_at, requested_at) DESC
        LIMIT ?`,
    [...baseArgs, limit],
  ) as any[];
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

  // Task interactions — what agents (and people) logged with context_task_log.
  const taskRows = await listTaskActivity({
    nestId: params.nestId,
    nodeId: params.nodeId,
    limit,
  });
  for (const t of taskRows) {
    const agent = typeof t.client?.agent === "string" ? t.client.agent : undefined;
    entries.push({
      type: "task_activity",
      nodeId: t.nodeId,
      actor: t.actor,
      at: t.at,
      detail: [t.status, excerpt(t.note, 200)].filter(Boolean).join(" · "),
      refId: t.id,
      ...(t.status ? { status: t.status } : {}),
      ...(agent ? { agent } : {}),
      ...(t.key ? { key: t.key } : {}),
      summary: describeTaskActivity(t),
    });
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

  // Newest first, capped. Parse to epoch millis before comparing — the
  // timestamps come from two formats: SQLite datetime('now') ("2024-01-15
  // 10:30:00", space-separated) and engine suggestion detected_at (ISO 8601,
  // "…T…Z"). A raw string compare would sort EVERY space-form before EVERY
  // ISO-form (space 0x20 < 'T' 0x54), floating all edit_proposed entries to
  // the top regardless of real time. `${at} ` → treat SQLite's space form as
  // UTC so it lines up with the ISO values.
  const ms = (at: string) => {
    if (!at) return 0;
    // SQLite datetime('now') is UTC but lacks the T/Z markers — V8 would parse
    // it as LOCAL time, skewing it against the ISO (UTC) detected_at values.
    // Normalise the space form to explicit ISO-UTC so both parse on one clock.
    const norm = at.includes("T") ? at : at.replace(" ", "T") + "Z";
    const t = Date.parse(norm);
    return Number.isNaN(t) ? 0 : t;
  };
  entries.sort((a, b) => ms(b.at) - ms(a.at));
  return entries.slice(0, limit);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function excerpt(body: string, max = 80): string {
  const s = (body || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function rowToComment(row: any): Comment {
  // Surface an anchor when EITHER the offsets OR the quoted text is present —
  // a text-only anchor (offsets null) is valid: the client highlighted a span
  // but couldn't map it to document offsets yet.
  const hasOffsets =
    row.anchor_start !== null && row.anchor_end !== null;
  const hasText = row.anchor_text !== null && row.anchor_text !== undefined;
  const anchor =
    hasOffsets || hasText
      ? {
          ...(hasOffsets
            ? { start: row.anchor_start, end: row.anchor_end }
            : {}),
          ...(hasText ? { text: row.anchor_text } : {}),
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
