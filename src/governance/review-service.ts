/**
 * Review Service — approval workflow ported from PromptOwl's documentLifecycle.ts.
 *
 * Handles: submit for review, approve, reject, cancel, review queue.
 * Permission checks use the stewardship resolution from stewardship-service.
 */

import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { resolveStewardsForNode, canUserApprove } from "./stewardship-service.js";
import type {
  ReviewRequest,
  ReviewRequestPriority,
  ReviewRequestStatus,
  ResolvedSteward,
} from "./types.js";

// ─── Submit for Review ──────────────────────────────────────────────────
// Ported from PromptOwl submitForReview()

export function submitForReview(params: {
  nestId: string;
  nodeId: string;
  version: number;
  requestedBy: string;
  note?: string;
  priority?: ReviewRequestPriority;
}): ReviewRequest {
  const db = getDb();

  // Check no pending review already exists for this node
  const existing = db
    .prepare(
      "SELECT id FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending'",
    )
    .get(params.nestId, params.nodeId) as { id: string } | undefined;

  if (existing) {
    throw new Error("A review is already pending for this node");
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO review_requests
     (id, nest_id, node_id, version, requested_by, request_note, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.nestId,
    params.nodeId,
    params.version,
    params.requestedBy,
    params.note || null,
    params.priority || "normal",
  );

  // Update node version status to pending_review
  db.prepare(
    "UPDATE node_versions SET status = 'pending_review' WHERE nest_id = ? AND node_id = ? AND version = ?",
  ).run(params.nestId, params.nodeId, params.version);

  return getReviewRequest(id)!;
}

// ─── Approve ────────────────────────────────────────────────────────────
// Ported from PromptOwl approveVersion()

export function approve(params: {
  nestId: string;
  nodeId: string;
  version: number;
  approvedBy: string;
  note?: string;
  override?: boolean;
}): ReviewRequest {
  const db = getDb();

  // Find pending review
  const pending = db
    .prepare(
      "SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    )
    .get(params.nestId, params.nodeId) as any;

  if (!pending) {
    throw new Error("No pending review for this node");
  }

  // Check permissions (unless override by super admin)
  if (!params.override) {
    const check = canUserApprove(
      params.nestId,
      params.nodeId,
      params.approvedBy,
    );
    if (!check.allowed) {
      throw new Error(check.reason);
    }
  }

  // Resolve the review
  db.prepare(
    `UPDATE review_requests
     SET status = 'approved', resolved_by = ?, resolved_at = datetime('now'),
         resolution_note = ?, is_override = ?
     WHERE id = ?`,
  ).run(
    params.approvedBy,
    params.note || null,
    params.override ? 1 : 0,
    pending.id,
  );

  // Update version status
  db.prepare(
    "UPDATE node_versions SET status = 'approved' WHERE nest_id = ? AND node_id = ? AND version = ?",
  ).run(params.nestId, params.nodeId, params.version);

  // Pin this as the approved version (for AI queries)
  db.prepare(
    `INSERT OR REPLACE INTO approved_versions (nest_id, node_id, approved_version, approved_by)
     VALUES (?, ?, ?, ?)`,
  ).run(params.nestId, params.nodeId, params.version, params.approvedBy);

  return getReviewRequest(pending.id)!;
}

// ─── Reject ─────────────────────────────────────────────────────────────
// Ported from PromptOwl rejectVersion()

export function reject(params: {
  nestId: string;
  nodeId: string;
  version: number;
  rejectedBy: string;
  note: string;
}): ReviewRequest {
  const db = getDb();

  const pending = db
    .prepare(
      "SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    )
    .get(params.nestId, params.nodeId) as any;

  if (!pending) {
    throw new Error("No pending review for this node");
  }

  const check = canUserApprove(
    params.nestId,
    params.nodeId,
    params.rejectedBy,
  );
  if (!check.allowed) {
    throw new Error(check.reason);
  }

  db.prepare(
    `UPDATE review_requests
     SET status = 'rejected', resolved_by = ?, resolved_at = datetime('now'), resolution_note = ?
     WHERE id = ?`,
  ).run(params.rejectedBy, params.note, pending.id);

  db.prepare(
    "UPDATE node_versions SET status = 'rejected' WHERE nest_id = ? AND node_id = ? AND version = ?",
  ).run(params.nestId, params.nodeId, params.version);

  return getReviewRequest(pending.id)!;
}

// ─── Cancel ─────────────────────────────────────────────────────────────

export function cancelReview(params: {
  nestId: string;
  nodeId: string;
  cancelledBy: string;
}): ReviewRequest | null {
  const db = getDb();

  const pending = db
    .prepare(
      "SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    )
    .get(params.nestId, params.nodeId) as any;

  if (!pending) return null;

  db.prepare(
    `UPDATE review_requests
     SET status = 'cancelled', resolved_by = ?, resolved_at = datetime('now')
     WHERE id = ?`,
  ).run(params.cancelledBy, pending.id);

  db.prepare(
    "UPDATE node_versions SET status = 'draft' WHERE nest_id = ? AND node_id = ? AND version = ?",
  ).run(params.nestId, params.nodeId, pending.version);

  return getReviewRequest(pending.id)!;
}

// ─── Queue ──────────────────────────────────────────────────────────────

export function getReviewQueue(params: {
  nestId?: string;
  status?: ReviewRequestStatus | ReviewRequestStatus[];
  stewardEmail?: string;
  limit?: number;
  offset?: number;
}): { requests: ReviewRequest[]; total: number } {
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
    db
      .prepare(`SELECT COUNT(*) as c FROM review_requests ${where}`)
      .get(...args) as { c: number }
  ).c;

  const limit = params.limit || 50;
  const offset = params.offset || 0;

  const rows = db
    .prepare(
      `SELECT * FROM review_requests ${where}
       ORDER BY
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         requested_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as any[];

  // If filtering by steward email, post-filter by steward resolution.
  // Resolver reads node_tag_index directly — no tags argument needed.
  let requests = rows.map(rowToReviewRequest);
  if (params.stewardEmail) {
    requests = requests.filter((r) => {
      const stewards = resolveStewardsForNode(r.nestId, r.nodeId);
      return stewards.some(
        (s) => s.steward.userEmail === params.stewardEmail,
      );
    });
  }

  return { requests, total };
}

export function getReviewHistory(
  nestId: string,
  nodeId: string,
): ReviewRequest[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? ORDER BY requested_at DESC",
    )
    .all(nestId, nodeId) as any[];
  return rows.map(rowToReviewRequest);
}

export function getPendingReview(
  nestId: string,
  nodeId: string,
): ReviewRequest | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    )
    .get(nestId, nodeId) as any;
  return row ? rowToReviewRequest(row) : null;
}

// ─── Permission Check ───────────────────────────────────────────────────
// Single source of truth lives in stewardship-service (with owner-cannot-approve
// separation-of-duties enforcement). Re-exported here for call-site compatibility.
export { canUserApprove };

// ─── Helpers ────────────────────────────────────────────────────────────

function getReviewRequest(id: string): ReviewRequest | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM review_requests WHERE id = ?")
    .get(id) as any;
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
