/**
 * Review Service — approval workflow ported from PromptOwl's documentLifecycle.ts.
 *
 * Handles: submit for review, approve, reject, cancel, review queue.
 * Permission checks use the stewardship resolution from stewardship-service.
 */

import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { notifyReviewRequested, notifyReviewResolved } from "./notify-service.js";
import { dispatchEvent } from "../notify/dispatch.js";
import { insertOrReplace, nowExpr } from "../db/sql.js";
import { engineCache } from "../nodes/engine.js";
import { safePublishDocument } from "./safe-publish.js";
import { resolveStewardsForNode, canUserApprove } from "./stewardship-service.js";
import * as versions from "./version-service.js";
import { buildTitleMap, describeNode } from "./title-resolver.js";
import type {
  ReviewRequest,
  ReviewRequestPriority,
  ReviewRequestStatus,
  ResolvedSteward,
} from "./types.js";

// ─── Submit for Review ──────────────────────────────────────────────────
// Ported from PromptOwl submitForReview()

export async function submitForReview(params: {
  nestId: string;
  nodeId: string;
  version: number;
  requestedBy: string;
  note?: string;
  priority?: ReviewRequestPriority;
}): Promise<ReviewRequest> {
  const db = getDb();

  // Check no pending review already exists for this node
  const existing = (await db.get(
    "SELECT id FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending'",
    [params.nestId, params.nodeId],
  )) as { id: string } | undefined;

  if (existing) {
    throw new Error("A review is already pending for this node");
  }

  const id = uuid();
  await db.run(
    `INSERT INTO review_requests
     (id, nest_id, node_id, version, requested_by, request_note, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.nestId,
      params.nodeId,
      params.version,
      params.requestedBy,
      params.note || null,
      params.priority || "normal",
    ],
  );

  // Update node version status to pending_review
  await db.run(
    "UPDATE node_versions SET status = 'pending_review' WHERE nest_id = ? AND node_id = ? AND version = ?",
    [params.nestId, params.nodeId, params.version],
  );

  void dispatchEvent({
    kind: "review_requested",
    nestId: params.nestId,
    subjectId: params.nodeId,
    actor: params.requestedBy,
    message: `Review requested on *${await describeNode(params.nestId, params.nodeId)}* (v${params.version}) by ${params.requestedBy}${params.note ? ` — "${params.note}"` : ""}`,
  });

  // Fan out to watchers of this doc + of agents flowing into it (HITL tags).
  // Best-effort inside notifyReviewRequested — never fails the submission.
  await notifyReviewRequested({
    nestId: params.nestId,
    nodeId: params.nodeId,
    requestedBy: params.requestedBy,
    reviewId: id,
  });

  return (await getReviewRequest(id))!;
}

// ─── Approve ────────────────────────────────────────────────────────────
// Ported from PromptOwl approveVersion()

export async function approve(params: {
  nestId: string;
  nodeId: string;
  version: number;
  approvedBy: string;
  note?: string;
  override?: boolean;
}): Promise<ReviewRequest> {
  const db = getDb();

  // Find pending review
  const pending = (await db.get(
    "SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    [params.nestId, params.nodeId],
  )) as any;

  if (!pending) {
    throw new Error("No pending review for this node");
  }

  // Check permissions (unless override by super admin)
  if (!params.override) {
    const check = await canUserApprove(
      params.nestId,
      params.nodeId,
      params.approvedBy,
    );
    if (!check.allowed) {
      throw new Error(check.reason);
    }
  }

  // Resolve the review
  await db.run(
    `UPDATE review_requests
     SET status = 'approved', resolved_by = ?, resolved_at = ${nowExpr(db)},
         resolution_note = ?, is_override = ?
     WHERE id = ?`,
    [params.approvedBy, params.note || null, params.override ? 1 : 0, pending.id],
  );

  void dispatchEvent({
    kind: "review_approved",
    nestId: params.nestId,
    subjectId: params.nodeId,
    actor: params.approvedBy,
    message: `*${await describeNode(params.nestId, params.nodeId)}* v${params.version} approved by ${params.approvedBy}`,
  });

  // Verdict fan-out: submitter + watchers hear the approval. Best-effort.
  await notifyReviewResolved({
    nestId: params.nestId,
    nodeId: params.nodeId,
    status: "approved",
    resolvedBy: params.approvedBy,
    requestedBy: pending.requested_by,
    reviewId: pending.id,
  });

  // Update version status. We write 'published' (not 'approved') so the DB
  // mirrors the engine's terminal status — history.yaml/frontmatter record
  // the post-approve state as published, and divergence between the two
  // breaks drift detection and display-status resolution.
  await db.run(
    "UPDATE node_versions SET status = 'published' WHERE nest_id = ? AND node_id = ? AND version = ?",
    [params.nestId, params.nodeId, params.version],
  );

  // Pin this as the approved version (for AI queries)
  await db.run(
    insertOrReplace(
      db,
      `INSERT INTO approved_versions (nest_id, node_id, approved_version, approved_by)
       VALUES (?, ?, ?, ?)`,
      ["nest_id", "node_id"],
      `approved_version = excluded.approved_version, approved_by = excluded.approved_by, approved_at = ${nowExpr(db)}`,
    ),
    [params.nestId, params.nodeId, params.version, params.approvedBy],
  );

  // Run engine publish so the on-disk file gets frontmatter.checksum +
  // status:published. Without this, drift detection silently no-ops on
  // subsequent local edits (see integrity.ts:133 — no checksum = drifted:false).
  //
  // Engine bumps the on-disk version (N → N+1) and appends an entry to
  // history.yaml. Mirror that entry into node_versions so the DB's view
  // of "latest version" stays in lockstep with the file. Without this
  // mirror, the next GET returns frontmatter.version = N+1, the UI sends
  // X-Base-Version: N+1, and checkConflict (which reads node_versions)
  // sees the DB stuck at N and 409s on every save.
  try {
    const { storage } = await engineCache.get(params.nestId);
    const result = await safePublishDocument(storage, params.nodeId, {
      editedBy: params.approvedBy,
      note: params.note || `Approved review request ${pending.id}`,
    });
    const engineVersion = result.versionEntry.version;
    if (engineVersion !== params.version) {
      const node = result.node;
      const tags = (node.frontmatter.tags || []) as string[];
      await versions.createVersion({
        nestId: params.nestId,
        nodeId: params.nodeId,
        version: engineVersion,
        content: node.body || "",
        author: params.approvedBy,
        status: "published",
        tags,
        changeNote: params.note || `Approved review request ${pending.id}`,
      });
      // Re-pin to the engine-bumped version so getDisplayStatus() resolves
      // the latest row (N+1) as "approved" rather than falling through to
      // "draft" because approved_version still pointed at N.
      await versions.setApprovedVersion(
        params.nestId,
        params.nodeId,
        engineVersion,
        params.approvedBy,
      );
    }
  } catch (err) {
    console.error(
      `publishDocument failed for ${params.nestId}/${params.nodeId} on approve:`,
      err,
    );
  }

  return (await getReviewRequest(pending.id))!;
}

// ─── Reject ─────────────────────────────────────────────────────────────
// Ported from PromptOwl rejectVersion()

export async function reject(params: {
  nestId: string;
  nodeId: string;
  version: number;
  rejectedBy: string;
  note: string;
}): Promise<ReviewRequest> {
  const db = getDb();

  const pending = (await db.get(
    "SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    [params.nestId, params.nodeId],
  )) as any;

  if (!pending) {
    throw new Error("No pending review for this node");
  }

  const check = await canUserApprove(
    params.nestId,
    params.nodeId,
    params.rejectedBy,
  );
  if (!check.allowed) {
    throw new Error(check.reason);
  }

  await db.run(
    `UPDATE review_requests
     SET status = 'rejected', resolved_by = ?, resolved_at = ${nowExpr(db)}, resolution_note = ?
     WHERE id = ?`,
    [params.rejectedBy, params.note, pending.id],
  );

  await db.run(
    "UPDATE node_versions SET status = 'rejected' WHERE nest_id = ? AND node_id = ? AND version = ?",
    [params.nestId, params.nodeId, params.version],
  );

  void dispatchEvent({
    kind: "review_rejected",
    nestId: params.nestId,
    subjectId: params.nodeId,
    actor: params.rejectedBy,
    message: `*${await describeNode(params.nestId, params.nodeId)}* v${params.version} rejected by ${params.rejectedBy}${params.note ? ` — "${params.note}"` : ""}`,
  });

  // Verdict fan-out: submitter + watchers hear the rejection. Best-effort.
  await notifyReviewResolved({
    nestId: params.nestId,
    nodeId: params.nodeId,
    status: "rejected",
    resolvedBy: params.rejectedBy,
    requestedBy: pending.requested_by,
    reviewId: pending.id,
  });

  return (await getReviewRequest(pending.id))!;
}

// ─── Cancel ─────────────────────────────────────────────────────────────

export async function cancelReview(params: {
  nestId: string;
  nodeId: string;
  cancelledBy: string;
}): Promise<ReviewRequest | null> {
  const db = getDb();

  const pending = (await db.get(
    "SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    [params.nestId, params.nodeId],
  )) as any;

  if (!pending) return null;

  await db.run(
    `UPDATE review_requests
     SET status = 'cancelled', resolved_by = ?, resolved_at = ${nowExpr(db)}
     WHERE id = ?`,
    [params.cancelledBy, pending.id],
  );

  await db.run(
    "UPDATE node_versions SET status = 'draft' WHERE nest_id = ? AND node_id = ? AND version = ?",
    [params.nestId, params.nodeId, pending.version],
  );

  return (await getReviewRequest(pending.id))!;
}

// ─── Queue ──────────────────────────────────────────────────────────────

export async function getReviewQueue(params: {
  nestId?: string;
  status?: ReviewRequestStatus | ReviewRequestStatus[];
  stewardEmail?: string;
  limit?: number;
  offset?: number;
}): Promise<{ requests: ReviewRequest[]; total: number }> {
  const db = getDb();
  let whereClauses: string[] = [];
  const args: any[] = [];

  if (params.nestId) {
    whereClauses.push("nest_id = ?");
    args.push(params.nestId);
  }

  if (params.status) {
    const statuses = Array.isArray(params.status)
      ? params.status
      : [params.status];
    whereClauses.push(
      `status IN (${statuses.map(() => "?").join(",")})`,
    );
    args.push(...statuses);
  }

  const where =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const total = (
    (await db.get(
      `SELECT COUNT(*) as c FROM review_requests ${where}`,
      args,
    )) as { c: number }
  ).c;

  const limit = params.limit || 50;
  const offset = params.offset || 0;

  const rows = (await db.all(
    `SELECT * FROM review_requests ${where}
       ORDER BY
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         requested_at DESC
       LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  )) as any[];

  // If filtering by steward email, post-filter by steward resolution.
  // Resolver reads node_tag_index directly — no tags argument needed.
  let requests = rows.map(rowToReviewRequest);
  if (params.stewardEmail) {
    const filtered: ReviewRequest[] = [];
    for (const r of requests) {
      const stewards = await resolveStewardsForNode(r.nestId, r.nodeId);
      if (stewards.some((s) => s.steward.userEmail === params.stewardEmail)) {
        filtered.push(r);
      }
    }
    requests = filtered;
  }

  // Resolve human-facing document titles. The governance DB only stores
  // node ids like "nodes/api-rate-limits"; rendering those raw leaks the
  // storage path into the UI (CU bug — steward review queue showed
  // "nodes/TitleA" instead of "TitleA"). Title lives in the on-disk
  // frontmatter, so we pull it via storage. Build one title map per nest
  // to avoid re-scanning when the queue spans multiple nests.
  const titleMapsByNest = new Map<string, Map<string, string>>();
  const nestIds = new Set(requests.map((r) => r.nestId));
  for (const nid of nestIds) {
    titleMapsByNest.set(nid, await buildTitleMap(nid));
  }
  requests = requests.map((r) => ({
    ...r,
    title: titleMapsByNest.get(r.nestId)?.get(r.nodeId),
  }));

  return { requests, total };
}

export async function getReviewHistory(
  nestId: string,
  nodeId: string,
): Promise<ReviewRequest[]> {
  const db = getDb();
  const rows = (await db.all(
    "SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? ORDER BY requested_at DESC",
    [nestId, nodeId],
  )) as any[];
  return rows.map(rowToReviewRequest);
}

export async function getPendingReview(
  nestId: string,
  nodeId: string,
): Promise<ReviewRequest | null> {
  const db = getDb();
  const row = (await db.get(
    "SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    [nestId, nodeId],
  )) as any;
  return row ? rowToReviewRequest(row) : null;
}

// ─── Permission Check ───────────────────────────────────────────────────
// Single source of truth lives in stewardship-service (with owner-cannot-approve
// separation-of-duties enforcement). Re-exported here for call-site compatibility.
export { canUserApprove };

// ─── Helpers ────────────────────────────────────────────────────────────

async function getReviewRequest(id: string): Promise<ReviewRequest | null> {
  const db = getDb();
  const row = (await db.get(
    "SELECT * FROM review_requests WHERE id = ?",
    [id],
  )) as any;
  return row ? rowToReviewRequest(row) : null;
}

function rowToReviewRequest(row: any): ReviewRequest {
  return {
    id: row.id,
    nestId: row.nest_id,
    nodeId: row.node_id,
    version: row.version,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    requestNote: row.request_note || undefined,
    status: row.status,
    resolvedBy: row.resolved_by || undefined,
    resolvedAt: row.resolved_at || undefined,
    resolutionNote: row.resolution_note || undefined,
    priority: row.priority,
  };
}
