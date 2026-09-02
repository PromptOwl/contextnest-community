/**
 * Nest activity feed — pending change submissions (review requests) merged
 * with annotation activity (new comment threads + replies), newest first.
 *
 * ADDITIVE sibling of the review queue: the queue endpoint (and the MCP
 * context_review_queue tool built on getReviewQueue) stay untouched — this
 * service only reads the same tables and interleaves them for the feed
 * endpoint. Comment items are access-filtered to documents the caller can
 * read via the same filterAccessible guard node listing uses; change items
 * mirror the queue exactly (the queue never access-filtered, it stamps
 * canReview per request — we do the same).
 *
 * Efficiency contract: a bounded number of queries (no N+1 per item) —
 *   1. pending review_requests, newest first, LIMIT offset+limit
 *   2. distinct commented node ids (small), access-filtered in memory
 *   3. comment rows JOIN threads over the accessible ids, LIMIT offset+limit
 * plus one title map per nest and one canUserApprove per distinct pending
 * node — then a merge-sort in memory and a slice for the page.
 */

import { getDb } from "../db/client.js";
import { filterAccessible } from "./access-guard.js";
import { canUserApprove } from "./stewardship-service.js";
import { buildTitleMap } from "./title-resolver.js";
import {
  expirePendingPushes,
  isNestReviewer,
} from "../nests/push-confirmation-service.js";
import type { PushManifestEntry } from "../nodes/publish-apply.js";
import type { ReviewRequest } from "./types.js";

export type FeedFilter = "all" | "changes" | "comments";

/** A pending change submission — the exact row the review queue shows today
 *  (every ReviewRequest field + resolved title + caller's canReview). */
export interface ChangeFeedItem extends ReviewRequest {
  type: "change";
  /** Authoritative "can this caller approve/reject" (same check the queue stamps). */
  canReview: boolean;
  /** Merge key — mirrors requestedAt so all feed items sort on one field. */
  createdAt: string;
}

/** One comment event — a new annotation thread, or a reply on one. */
export interface CommentFeedItem {
  type: "comment";
  /** The annotation comment id. */
  id: string;
  threadId: string;
  nodeId: string;
  /** Resolved document title (frontmatter); undefined when the doc is gone. */
  title?: string;
  /** Author email. */
  author: string;
  /** Body excerpt, ~200 chars. */
  snippet: string;
  createdAt: string;
  /** Thread's current resolved state (not the state at posting time). */
  resolved: boolean;
  /** false = the comment that opened the thread; true = a reply. */
  isReply: boolean;
}

/** A held push awaiting confirmation (Push Confirmation Gate). */
export interface PendingPushFeedItem {
  type: "pending_push";
  /** The pending_pushes id. */
  id: string;
  nestId: string;
  nestName: string;
  docCount: number;
  manifest: PushManifestEntry[];
  submitterLabel: string | null;
  submitterEmail: string | null;
  createdAt: string;
  expiresAt: string;
  /** Whether THIS caller may confirm/reject it (submitter OR reviewer). */
  canConfirm: boolean;
}

export type FeedItem = ChangeFeedItem | CommentFeedItem | PendingPushFeedItem;

export interface NestFeed {
  items: FeedItem[];
  /** Total items matching the active filter (pre-pagination). */
  total: number;
  /** Per-type totals regardless of filter — the UI badge binds to changes. */
  counts: { changes: number; comments: number; pending_pushes: number };
}

const SNIPPET_CHARS = 200;

function snippet(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS
    ? `${flat.slice(0, SNIPPET_CHARS)}…`
    : flat;
}

export async function getNestFeed(params: {
  nestId: string;
  userId: string;
  userEmail: string;
  filter?: FeedFilter;
  limit?: number;
  offset?: number;
}): Promise<NestFeed> {
  const db = getDb();
  const filter = params.filter ?? "all";
  const limit =
    Number.isFinite(params.limit) && (params.limit as number) > 0
      ? Math.min(params.limit as number, 200)
      : 50;
  const offset =
    Number.isFinite(params.offset) && (params.offset as number) > 0
      ? (params.offset as number)
      : 0;
  // Each source only needs its newest offset+limit rows: the merged page
  // [offset, offset+limit) is always a subset of that window.
  const fetchWindow = offset + limit;

  const titles = await buildTitleMap(params.nestId);

  // ── Changes (pending review requests) ───────────────────────────────────
  let changes: ChangeFeedItem[] = [];
  let changesTotal = 0;
  {
    changesTotal = (
      (await db.get(
        "SELECT COUNT(*) AS c FROM review_requests WHERE nest_id = ? AND status = 'pending'",
        [params.nestId],
      )) as { c: number }
    ).c;
    if (filter !== "comments" && changesTotal > 0) {
      const rows = (await db.all(
        `SELECT * FROM review_requests
          WHERE nest_id = ? AND status = 'pending'
          ORDER BY requested_at DESC, id DESC
          LIMIT ?`,
        [params.nestId, fetchWindow],
      )) as any[];

      // One authoritative approve-check per distinct node (mirrors the
      // queue route), not per row — resolved in parallel across nodes.
      const distinctNodeIds = [
        ...new Set(rows.map((r) => r.node_id as string)),
      ];
      const canReviewByNode = new Map<string, boolean>(
        await Promise.all(
          distinctNodeIds.map(
            async (nodeId): Promise<[string, boolean]> => [
              nodeId,
              (
                await canUserApprove(params.nestId, nodeId, params.userEmail)
              ).allowed,
            ],
          ),
        ),
      );

      changes = rows.map((row) => ({
        type: "change" as const,
        id: row.id,
        nestId: row.nest_id,
        nodeId: row.node_id,
        title: titles.get(row.node_id),
        version: row.version,
        requestedBy: row.requested_by,
        requestedAt: row.requested_at,
        requestNote: row.request_note || undefined,
        status: row.status,
        resolvedBy: row.resolved_by || undefined,
        resolvedAt: row.resolved_at || undefined,
        resolutionNote: row.resolution_note || undefined,
        priority: row.priority,
        canReview: canReviewByNode.get(row.node_id) ?? false,
        createdAt: row.requested_at,
      }));
    }
  }

  // ── Comments (annotation threads + replies) ─────────────────────────────
  // Access filtering can't be pushed into SQL, but it CAN be done once over
  // the (small) set of distinct commented node ids — then the comment page
  // query paginates exactly over the accessible set. No per-item checks.
  let comments: CommentFeedItem[] = [];
  let commentsTotal = 0;
  {
    const nodeRows = (await db.all(
      "SELECT DISTINCT node_id AS id FROM annotation_threads WHERE nest_id = ?",
      [params.nestId],
    )) as Array<{ id: string }>;
    const accessible = await filterAccessible(
      params.nestId,
      params.userId,
      params.userEmail,
      nodeRows,
    );
    if (accessible.length > 0) {
      const placeholders = accessible.map(() => "?").join(",");
      const ids = accessible.map((n) => n.id);
      commentsTotal = (
        (await db.get(
          `SELECT COUNT(*) AS c
             FROM annotation_comments c
             JOIN annotation_threads t ON t.id = c.thread_id
            WHERE t.nest_id = ? AND t.node_id IN (${placeholders})`,
          [params.nestId, ...ids],
        )) as { c: number }
      ).c;

      if (filter !== "changes" && commentsTotal > 0) {
        const rows = (await db.all(
          `SELECT c.id, c.thread_id, c.author, c.body, c.created_at,
                  t.node_id, t.status,
                  CASE WHEN c.id = (
                    SELECT c2.id FROM annotation_comments c2
                     WHERE c2.thread_id = c.thread_id
                     ORDER BY c2.created_at ASC, c2.id ASC LIMIT 1
                  ) THEN 0 ELSE 1 END AS is_reply
             FROM annotation_comments c
             JOIN annotation_threads t ON t.id = c.thread_id
            WHERE t.nest_id = ? AND t.node_id IN (${placeholders})
            ORDER BY c.created_at DESC, c.id DESC
            LIMIT ?`,
          [params.nestId, ...ids, fetchWindow],
        )) as any[];

        comments = rows.map((row) => ({
          type: "comment" as const,
          id: row.id,
          threadId: row.thread_id,
          nodeId: row.node_id,
          title: titles.get(row.node_id),
          author: row.author,
          snippet: snippet(row.body),
          createdAt: row.created_at,
          resolved: row.status === "resolved",
          isReply: Number(row.is_reply) === 1,
        }));
      }
    }
  }

  // ── Pending pushes (Push Confirmation Gate) ─────────────────────────────
  // Held ctx pushes awaiting confirmation. They ride the "changes" lane (a
  // pending write, like a review request), never the comments lane.
  let pendingPushes: PendingPushFeedItem[] = [];
  let pendingPushesTotal = 0;
  {
    await expirePendingPushes(params.nestId);
    pendingPushesTotal = (
      (await db.get(
        "SELECT COUNT(*) AS c FROM pending_pushes WHERE nest_id = ? AND status = 'pending'",
        [params.nestId],
      )) as { c: number }
    ).c;
    if (filter !== "comments" && pendingPushesTotal > 0) {
      const rows = (await db.all(
        `SELECT * FROM pending_pushes
          WHERE nest_id = ? AND status = 'pending'
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        [params.nestId, fetchWindow],
      )) as any[];
      // One nest-level reviewer check; per-item canConfirm folds in "am I the
      // submitter" so a write-tier submitter sees its own held push actionable.
      const reviewer = await isNestReviewer(
        params.nestId,
        params.userId,
        params.userEmail,
      );
      const nameRow = (await db.get("SELECT name FROM nests WHERE id = ?", [
        params.nestId,
      ])) as { name?: string } | undefined;
      const nestName = nameRow?.name ?? params.nestId;
      pendingPushes = rows.map((row) => {
        let manifest: PushManifestEntry[] = [];
        try {
          manifest = JSON.parse(row.manifest_json);
        } catch {
          manifest = [];
        }
        return {
          type: "pending_push" as const,
          id: row.id,
          nestId: row.nest_id,
          nestName,
          docCount: row.doc_count,
          manifest,
          submitterLabel: row.submitter_label,
          submitterEmail: row.submitter_email,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          canConfirm: reviewer || row.submitter_user_id === params.userId,
        };
      });
    }
  }

  // ── Merge newest-first + page ───────────────────────────────────────────
  const merged: FeedItem[] = [...changes, ...comments, ...pendingPushes].sort(
    (a, b) => {
      const byTime = b.createdAt.localeCompare(a.createdAt);
      if (byTime !== 0) return byTime;
      return b.id.localeCompare(a.id);
    },
  );

  const total =
    filter === "changes"
      ? changesTotal + pendingPushesTotal
      : filter === "comments"
        ? commentsTotal
        : changesTotal + commentsTotal + pendingPushesTotal;

  return {
    items: merged.slice(offset, offset + limit),
    total,
    counts: {
      changes: changesTotal,
      comments: commentsTotal,
      pending_pushes: pendingPushesTotal,
    },
  };
}
