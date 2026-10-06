/**
 * Review Service — approval workflow ported from PromptOwl's documentLifecycle.ts.
 *
 * Handles: submit for review, approve, reject, cancel, review queue.
 * Permission checks use the stewardship resolution from stewardship-service.
 */

import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { ConflictError } from "../shared/errors.js";
import {
  notifyReviewRequested,
  notifyReviewResolved,
  markNotificationsReadBySubject,
} from "./notify-service.js";
import { dispatchEvent } from "../notify/dispatch.js";
import { notifyNestEvent } from "../notify/notify.js";
import { sendEmailToRecipient } from "../notify/email.js";
import { insertOrReplace, nowExpr } from "../db/sql.js";
import { withNodeWriteLock, nodeWriteKey } from "../shared/node-write-lock.js";
import { engineCache, engineApi, opContext } from "../nodes/engine.js";
import { resolveStewardsForNode, canUserApprove } from "./stewardship-service.js";
import * as versions from "./version-service.js";
import {
  buildTitleMap,
  titleForNode,
  buildDocContext,
  nestName,
  prettyFolderPath,
} from "./title-resolver.js";
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
  /** Request origin, for building the notification's document link. */
  baseUrl?: string;
  /** Caller attribution for the submission (§9.4). Submitting is the moment a
   *  draft reaches the engine's append-only chain, so it lands on the entry
   *  sealed below — the engine models `client` on VersionEntry. */
  client?: ClientMetadata;
}): Promise<ReviewRequest> {
  const db = getDb();

  // Everything that decides WHICH version goes to review — and the chain append
  // that seals it — runs under the same per-node lock approve/reject take, and
  // that updateNode takes for a draft save. Submitting is the one moment a
  // draft reaches the engine's append-only history, so an unguarded append here
  // is the exact drift `version-chain-graft.test.ts` exists to catch: an author
  // save landing between the read below and the seal would let the chain be
  // appended against a version that had already moved.
  const { id, version } = await withNodeWriteLock(
    nodeWriteKey(params.nestId, params.nodeId),
    async () => {
      // Check no pending review already exists for this node
      const existing = (await db.get(
        "SELECT id FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending'",
        [params.nestId, params.nodeId],
      )) as { id: string } | undefined;

      if (existing) {
        throw new Error("A review is already pending for this node");
      }

      // Read INSIDE the lock, for the reason approve does: the caller's
      // `version` was read before the lock and an author save may have moved
      // the document since. The review row, the status flip and the seal below
      // must all name the same version, and it must be the current one.
      const version =
        (await versions.getCurrentVersion(params.nestId, params.nodeId)) ||
        params.version;

      const id = uuid();
      await db.run(
        `INSERT INTO review_requests
     (id, nest_id, node_id, version, requested_by, request_note, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          params.nestId,
          params.nodeId,
          version,
          params.requestedBy,
          params.note || null,
          params.priority || "normal",
        ],
      );

      // Update node version status to pending_review
      await db.run(
        "UPDATE node_versions SET status = 'pending_review' WHERE nest_id = ? AND node_id = ? AND version = ?",
        [params.nestId, params.nodeId, version],
      );

      // Seal the submitted bytes into the engine's history chain. Draft saves
      // no longer do this (see the draft branch of updateNode) precisely so
      // they stay discardable — but handing work to a reviewer is not a draft
      // save. From here the exact reviewed version is reconstructable, which is
      // what the review panel, the version list and the audit trail all read.
      //
      // Best-effort: a broken chain must not cost someone their submission, and
      // the reviewer reads the live file either way.
      try {
        const { storage, versions: versionManager } = await engineCache.get(
          params.nestId,
        );
        const node = await storage.readDocument(params.nodeId);
        const history = await versionManager.getHistory(params.nodeId);
        // Resubmitting without editing (a rejection bounced straight back)
        // leaves the version where it was — already sealed, and appending it
        // twice would put a duplicate number in the chain.
        const alreadySealed = (history?.versions ?? []).some(
          (v) => v.version === (node.frontmatter.version ?? 1),
        );
        if (!alreadySealed) {
          await versionManager.createVersion(node, params.requestedBy, {
            note: params.note || "Submitted for review",
            ...(params.client ? { client: params.client } : {}),
          });
        }
      } catch (err) {
        console.error(
          "VersionManager.createVersion failed (submit for review)",
          params.nestId,
          params.nodeId,
          err,
        );
      }

      return { id, version };
    },
  );

  // Notifications run OUTSIDE the lock: they are I/O against Slack, Teams and
  // SMTP, and holding a node's write lock across them would block the author's
  // next save on someone else's mail server.
  const reviewCtx = await buildDocContext(params.nestId, params.nodeId, params.baseUrl);
  void dispatchEvent({
    kind: "review_requested",
    nestId: params.nestId,
    subjectId: params.nodeId,
    actor: params.requestedBy,
    message: `Review requested on *${reviewCtx.label}* (v${version}) by ${params.requestedBy}${params.note ? ` — "${params.note}"` : ""}`,
  });
  // SLACK_WEBHOOK_URL + email connector (digest-batched). Complements the
  // connector-table dispatch above; email is the piece connectors don't cover.
  void notifyNestEvent(
    params.nestId,
    `:memo: Review requested on *${reviewCtx.label}* (v${version}) by ${params.requestedBy}${params.note ? ` — "${params.note}"` : ""}`,
    {
      status: "pending_review",
      docTitle: reviewCtx.docTitle,
      path: reviewCtx.path,
      link: reviewCtx.link,
      actor: params.requestedBy,
      version,
      note: params.note || null,
    },
  );

  // Fan out to watchers of this doc + of agents flowing into it (HITL tags).
  // Best-effort inside notifyReviewRequested — never fails the submission.
  await notifyReviewRequested({
    nestId: params.nestId,
    nodeId: params.nodeId,
    requestedBy: params.requestedBy,
    reviewId: id,
  });

  // Email every reviewer steward so the people who can approve it know it's
  // waiting — one send to the whole list, best-effort, complementing the
  // team-channel digest + inbox fan-out above. Skip the submitter.
  try {
    const stewards = await resolveStewardsForNode(params.nestId, params.nodeId);
    const reviewers = [
      ...new Set(
        stewards
          .filter((s) => s.steward.role === "reviewer")
          .map((s) => s.steward.userEmail.toLowerCase()),
      ),
    ].filter((email) => email !== params.requestedBy.toLowerCase());
    if (reviewers.length > 0) {
      void sendEmailToRecipient(reviewers, {
        status: "pending_review",
        docTitle: reviewCtx.docTitle,
        path: reviewCtx.path,
        link: reviewCtx.link,
        actor: params.requestedBy,
        version,
        note: params.note || null,
      });
    }
  } catch (err) {
    console.error(
      "[notify] reviewer email fan-out failed",
      params.nestId,
      params.nodeId,
      err,
    );
  }

  return (await getReviewRequest(id))!;
}

// ─── Repoint pending review ─────────────────────────────────────────────
// The author edited their own pending submission, so updateNode drafted a new
// version (N+1). That revision is NOT in the engine's hash chain — draft saves
// stopped appending to it, and only submitting or publishing seals one — so the
// version this repoints onto is unsealed until the review resolves. Approving
// publishes it and seals it then; rejecting leaves it as the discardable draft
// it already was.
//
// All this does is move the open review request onto the new version so the
// steward approves the edited content, keeping the SAME review row (no restart,
// no re-notify, no duplicate submission). The old version drops back to draft;
// the new one carries the pending_review flag. history.yaml is untouched here,
// as it always was.
export async function repointPendingReview(params: {
  nestId: string;
  nodeId: string;
  newVersion: number;
}): Promise<void> {
  const db = getDb();

  const pending = (await db.get(
    "SELECT id, version FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
    [params.nestId, params.nodeId],
  )) as { id: string; version: number } | undefined;

  if (!pending || pending.version === params.newVersion) return;

  // One transaction: the review pointer and both version-status flips must
  // land together. A partial write would leave review_requests.version and
  // node_versions.status disagreeing about which version is under review —
  // wrong per-version history badges until the next resolve.
  await db.transaction(async (tx) => {
    await tx.run("UPDATE review_requests SET version = ? WHERE id = ?", [
      params.newVersion,
      pending.id,
    ]);
    await tx.run(
      "UPDATE node_versions SET status = 'draft' WHERE nest_id = ? AND node_id = ? AND version = ?",
      [params.nestId, params.nodeId, pending.version],
    );
    await tx.run(
      "UPDATE node_versions SET status = 'pending_review' WHERE nest_id = ? AND node_id = ? AND version = ?",
      [params.nestId, params.nodeId, params.newVersion],
    );
  });
}

// ─── Approve ────────────────────────────────────────────────────────────
// Ported from PromptOwl approveVersion()

export async function approve(params: {
  nestId: string;
  nodeId: string;
  approvedBy: string;
  note?: string;
  override?: boolean;
  /** Request origin, for building the notification's document link. */
  baseUrl?: string;
  /** Caller attribution for the approval (§9.4). An approval publishes, so
   *  when the engine bumps the version it seals, the new row carries it. */
  client?: ClientMetadata;
}): Promise<ReviewRequest> {
  // Serialize against a concurrent author edit of the same node. Authors can
  // now revise their own pending submission, so an autosave/save and this
  // approval could otherwise interleave — resolving the review against a stale
  // version and orphaning the freshly-drafted edit. The version to approve is
  // read INSIDE the lock so it reflects the author's latest committed edit.
  const { pending, version } = await withNodeWriteLock(nodeWriteKey(params.nestId, params.nodeId), async () => {
    const db = getDb();
    const version = await versions.getCurrentVersion(params.nestId, params.nodeId);

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

    // Update version status. We write 'published' (not 'approved') so the DB
    // mirrors the engine's terminal status — history.yaml/frontmatter record
    // the post-approve state as published, and divergence between the two
    // breaks drift detection and display-status resolution.
    //
    // No `client_json` here on purpose: this row was sealed by the AUTHOR's
    // write and already carries the author's attribution. Overwriting it with
    // the approver's would rewrite history — the approver's block belongs on
    // the version the engine's publish bumps to, written further down.
    await db.run(
      "UPDATE node_versions SET status = 'published' WHERE nest_id = ? AND node_id = ? AND version = ?",
      [params.nestId, params.nodeId, version],
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
      [params.nestId, params.nodeId, version, params.approvedBy],
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
      const note = params.note || `Approved review request ${pending.id}`;
      // Publish through the engine's canonical operation, so an approval seals
      // its version and checkpoint exactly the way every other surface does —
      // and regenerates the index, which a bare publish call does not.
      const { version: engineVersion } = await engineApi.run<{ version: number }>(
        "context_publish",
        { id: params.nodeId, note },
        await opContext(params.nestId, params.approvedBy),
      );
      if (engineVersion !== version) {
        // The operation reports the version, not the document — re-read for the
        // body and tags the governance row mirrors.
        const node = await storage.readDocument(params.nodeId);
        const tags = (node.frontmatter.tags || []) as string[];
        await versions.createVersion({
          nestId: params.nestId,
          nodeId: params.nodeId,
          version: engineVersion,
          content: node.body || "",
          author: params.approvedBy,
          status: "published",
          tags,
          changeNote: note,
          client: params.client,
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

    return { pending, version };
  });

  // Notifications run OUTSIDE the lock, as in submitForReview: the approval is
  // committed, and the author's next save shouldn't wait on the fan-out.
  const approveCtx = await buildDocContext(params.nestId, params.nodeId, params.baseUrl);
  void dispatchEvent({
    kind: "review_approved",
    nestId: params.nestId,
    subjectId: params.nodeId,
    actor: params.approvedBy,
    message: `*${approveCtx.label}* v${version} approved by ${params.approvedBy}`,
  });

  // Verdict fan-out: submitter + watchers hear the approval. Best-effort.
  await notifyReviewResolved({
    nestId: params.nestId,
    nodeId: params.nodeId,
    status: "approved",
    resolvedBy: params.approvedBy,
    requestedBy: pending.requested_by,
    reviewId: pending.id,
    label: approveCtx.label,
  });

  void notifyNestEvent(
    params.nestId,
    `:white_check_mark: *${approveCtx.label}* v${version} approved by ${params.approvedBy}`,
    {
      status: "approved",
      docTitle: approveCtx.docTitle,
      path: approveCtx.path,
      link: approveCtx.link,
      actor: params.approvedBy,
      version: version,
    },
    // The verdict emails the submitter directly (below), not the shared
    // NOTIFY_EMAIL_TO team inbox — skip the team-channel email; Slack/Teams fire.
    { skipEmail: true },
  );

  // Email the submitter their verdict, unless they approved it themselves.
  if (pending.requested_by?.toLowerCase() !== params.approvedBy.toLowerCase()) {
    void sendEmailToRecipient(pending.requested_by, {
      status: "approved",
      docTitle: approveCtx.docTitle,
      path: approveCtx.path,
      link: approveCtx.link,
      actor: params.approvedBy,
      version: version,
      note: params.note || null,
    });
  }

  return (await getReviewRequest(pending.id))!;
}

// ─── Reject ─────────────────────────────────────────────────────────────
// Ported from PromptOwl rejectVersion()

export async function reject(params: {
  nestId: string;
  nodeId: string;
  rejectedBy: string;
  note: string;
  /** Request origin, for building the notification's document link. */
  baseUrl?: string;
}): Promise<ReviewRequest> {
  // Same lock as approve: serialize against a concurrent author edit so the
  // rejected version reflects the author's latest committed edit.
  const { pending, version } = await withNodeWriteLock(nodeWriteKey(params.nestId, params.nodeId), async () => {
    const db = getDb();
    const version = await versions.getCurrentVersion(params.nestId, params.nodeId);

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
      [params.nestId, params.nodeId, version],
    );

    return { pending, version };
  });

  // Notifications run outside the lock, same as approve.
  const rejectCtx = await buildDocContext(params.nestId, params.nodeId, params.baseUrl);
  void dispatchEvent({
    kind: "review_rejected",
    nestId: params.nestId,
    subjectId: params.nodeId,
    actor: params.rejectedBy,
    message: `*${rejectCtx.label}* v${version} rejected by ${params.rejectedBy}${params.note ? ` — "${params.note}"` : ""}`,
  });
  void notifyNestEvent(
    params.nestId,
    `:x: *${rejectCtx.label}* v${version} rejected by ${params.rejectedBy} — "${params.note}"`,
    {
      status: "rejected",
      docTitle: rejectCtx.docTitle,
      path: rejectCtx.path,
      link: rejectCtx.link,
      actor: params.rejectedBy,
      version: version,
      note: params.note || null,
    },
    // Verdict emails the submitter directly (below), not the team inbox.
    { skipEmail: true },
  );

  // Email the submitter their verdict, unless they rejected it themselves.
  if (pending.requested_by?.toLowerCase() !== params.rejectedBy.toLowerCase()) {
    void sendEmailToRecipient(pending.requested_by, {
      status: "rejected",
      docTitle: rejectCtx.docTitle,
      path: rejectCtx.path,
      link: rejectCtx.link,
      actor: params.rejectedBy,
      version: version,
      note: params.note || null,
    });
  }

  // Verdict fan-out: submitter + watchers hear the rejection. Best-effort.
  await notifyReviewResolved({
    nestId: params.nestId,
    nodeId: params.nodeId,
    status: "rejected",
    resolvedBy: params.rejectedBy,
    requestedBy: pending.requested_by,
    reviewId: pending.id,
    label: rejectCtx.label,
  });

  return (await getReviewRequest(pending.id))!;
}

// ─── Cancel ─────────────────────────────────────────────────────────────

export async function cancelReview(params: {
  nestId: string;
  nodeId: string;
  cancelledBy: string;
}): Promise<ReviewRequest | null> {
  // Same lock as approve/reject so a cancel can't interleave with an author
  // edit and release the lock while an edit is mid-write.
  return withNodeWriteLock(nodeWriteKey(params.nestId, params.nodeId), async () => {
    const db = getDb();

    const pending = (await db.get(
      "SELECT * FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1",
      [params.nestId, params.nodeId],
    )) as any;

    if (!pending) return null;

    // Withdrawing is the author's own undo, so the submitter always may.
    // Anyone else needs the rights they'd need to resolve it any other way.
    if (
      String(pending.requested_by).toLowerCase() !==
      params.cancelledBy.toLowerCase()
    ) {
      const verdict = await canUserApprove(
        params.nestId,
        params.nodeId,
        params.cancelledBy,
      );
      if (!verdict.allowed) {
        throw new Error(
          "Only the submitter or a reviewer can withdraw this review",
        );
      }
    }

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
  });
}

// ─── Queue ──────────────────────────────────────────────────────────────

export async function getReviewQueue(params: {
  nestId?: string;
  nestIds?: string[];
  status?: ReviewRequestStatus | ReviewRequestStatus[];
  stewardEmail?: string;
  // SQL-level "requested by" filter (distinct from stewardEmail, which
  // post-filters by steward resolution). Used by /me/work to get an exact
  // COUNT of a caller's own pending requests in nests they can't otherwise
  // approve — a JS post-filter over one paginated page can't produce an
  // accurate total.
  requestedByEmail?: string;
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

  // Scope to a set of nests (the caller's visible nests, for the cross-nest
  // /me/work inbox). An empty set means "no visible nests" — short-circuit
  // rather than emit `IN ()`, which is invalid SQL and would otherwise scan
  // every nest before the caller filters them out anyway.
  if (params.nestIds) {
    if (params.nestIds.length === 0) return { requests: [], total: 0 };
    whereClauses.push(
      `nest_id IN (${params.nestIds.map(() => "?").join(",")})`,
    );
    args.push(...params.nestIds);
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

  if (params.requestedByEmail) {
    whereClauses.push("requested_by = ?");
    args.push(params.requestedByEmail);
  }

  const where =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  // Number(): Postgres returns COUNT(*) as a string (bigint); coerce so
  // callers (e.g. /me/work's pagination.total) get a real number, not "3".
  const total = Number(
    (
      (await db.get(
        `SELECT COUNT(*) as c FROM review_requests ${where}`,
        args,
      )) as { c: number }
    ).c,
  );

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

// ─── Deletion Requests ──────────────────────────────────────────────────
// Deleting a node is write-tier, so a reader/editor without that tier flags it
// here with a reason and a writer resolves it from the queue. Separate rows
// from review_requests on purpose: a flagged node is NOT under review, and
// reusing that table would lock it against edits and surface it in the
// content-review feed. Honouring a request deletes the node, which purges the
// row via NODE_KEYED_TABLES; declining keeps it with the resolver's note.

/**
 * "nest_archive" is an editor asking for the nest to be ARCHIVED rather than
 * destroyed (CU-wdqcpzy80h). It rides this table because the request, queue,
 * notification, decline and withdraw paths are identical to a deletion's — only
 * what honouring it does differs, in one branch of the resolve route. The
 * column is plain TEXT with no CHECK, so the extra value needs no migration.
 */
export type DeletionTargetType =
  | "document"
  | "folder"
  | "nest"
  | "nest_archive";

/** True for the two whole-nest targets — same label, same admin gate. */
export function isNestTarget(t: DeletionTargetType): boolean {
  return t === "nest" || t === "nest_archive";
}

export interface DeletionRequest {
  id: string;
  nestId: string;
  /** The target: a node id, a folder path ("api/limits"), or the nest id.
   *  `targetType` says which — one column, one code path for all three. */
  nodeId: string;
  targetType: DeletionTargetType;
  title?: string;
  requestedBy: string;
  reason: string;
  status: "pending" | "declined";
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

/** Human label for a target, used in the queue, inbox rows and emails. */
export async function deletionTargetTitle(
  request: Pick<DeletionRequest, "nestId" | "nodeId" | "targetType">,
  titles?: Map<string, string>,
): Promise<string> {
  if (request.targetType === "folder") return prettyFolderPath(request.nodeId);
  if (isNestTarget(request.targetType)) return await nestName(request.nestId);
  return (
    titles?.get(request.nodeId) ??
    (await titleForNode(request.nestId, request.nodeId))
  );
}

/** Emails of the people who can action a deletion: the nest owner plus
 *  owner/admin collaborators. Mirrors the UI's `canManage` — the tier that
 *  sees the Delete affordance is the tier that gets told about a request. */
async function nestAdminEmails(nestId: string): Promise<string[]> {
  const db = getDb();
  const rows = (await db.all(
    `SELECT u.email FROM nests n JOIN users u ON u.id = n.user_id WHERE n.id = ?
     UNION
     SELECT u.email FROM nest_collaborators nc JOIN users u ON u.id = nc.user_id
      WHERE nc.nest_id = ? AND nc.permission IN ('owner', 'admin')`,
    [nestId, nestId],
  )) as Array<{ email: string }>;
  return [...new Set(rows.map((r) => r.email.toLowerCase()))];
}

/** Inbox rows for /me/work. Best-effort by contract, like every other
 *  notification path here — a delivery failure must never fail the action. */
async function inboxInsert(
  nestId: string,
  recipients: string[],
  kind: string,
  subjectId: string,
  message: string,
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  for (const email of recipients) {
    try {
      await db.run(
        `INSERT INTO notifications (id, nest_id, user_email, kind, subject_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), nestId, email.toLowerCase(), kind, subjectId, message, now],
      );
    } catch (err) {
      console.error("[notify] deletion inbox insert failed", nestId, email, err);
    }
  }
}

/**
 * Notification context for any target kind. Documents keep buildDocContext's
 * title + folder + deep link; a folder or nest has no document to describe, so
 * the label is the path / nest name and the link points at the nest.
 */
async function deletionTargetContext(
  request: DeletionRequest,
  baseUrl?: string,
): Promise<{
  noun: string;
  label: string;
  docTitle: string;
  path: string;
  link: string;
}> {
  if (request.targetType === "document") {
    const ctx = await buildDocContext(request.nestId, request.nodeId, baseUrl);
    return { noun: "document", ...ctx };
  }
  const name = await nestName(request.nestId);
  const label =
    request.targetType === "folder"
      ? prettyFolderPath(request.nodeId)
      : name;
  return {
    noun: request.targetType === "nest_archive" ? "nest" : request.targetType,
    label,
    docTitle: label,
    path: name,
    link: baseUrl
      ? `${baseUrl}/?nest=${encodeURIComponent(request.nestId)}`
      : "",
  };
}

/**
 * Tell the nest admins a document was flagged: inbox row, Slack/Teams (via
 * both the connector table and the digest), and a direct email. The requester
 * is skipped — they know, they asked.
 */
async function notifyDeletionRequested(
  request: DeletionRequest,
  baseUrl?: string,
): Promise<void> {
  try {
    const ctx = await deletionTargetContext(request, baseUrl);
    // A nest_archive request is an ask to ARCHIVE, not delete (CU-wdqcpzy80h) —
    // the notification has to say so, mirroring the "archived" vs "deleted"
    // verb split notifyDeletionResolved already makes for the verdict.
    const isArchiveRequest = request.targetType === "nest_archive";
    const line = isArchiveRequest
      ? `Archive requested for ${ctx.noun} *${ctx.label}* by ${request.requestedBy} — "${request.reason}"`
      : `Deletion requested for ${ctx.noun} *${ctx.label}* by ${request.requestedBy} — "${request.reason}"`;
    const admins = (await nestAdminEmails(request.nestId)).filter(
      (e) => e !== request.requestedBy.toLowerCase(),
    );

    await inboxInsert(
      request.nestId,
      admins,
      "deletion_requested",
      request.id,
      isArchiveRequest
        ? `${ctx.noun} "${ctx.docTitle}" was requested to be archived by ${request.requestedBy} — "${request.reason}"`
        : `${ctx.noun === "document" ? "" : `${ctx.noun} `}"${ctx.docTitle}" was flagged for deletion by ${request.requestedBy} — "${request.reason}"`,
    );

    void dispatchEvent({
      kind: "deletion_requested",
      nestId: request.nestId,
      subjectId: request.nodeId,
      actor: request.requestedBy,
      message: line,
    });
    void notifyNestEvent(
      request.nestId,
      `:wastebasket: ${line}`,
      {
        status: "deletion_requested",
        docTitle: ctx.docTitle,
        path: ctx.path,
        link: ctx.link,
        actor: request.requestedBy,
        note: request.reason,
      },
      // The admins are emailed directly below; don't also hit the shared
      // NOTIFY_EMAIL_TO team inbox with the same event.
      { skipEmail: true },
    );
    if (admins.length > 0) {
      void sendEmailToRecipient(admins, {
        status: "deletion_requested",
        docTitle: ctx.docTitle,
        path: ctx.path,
        link: ctx.link,
        actor: request.requestedBy,
        note: request.reason,
      });
    }
  } catch (err) {
    console.error(
      "[notify] deletion request fan-out failed",
      request.nestId,
      request.nodeId,
      err,
    );
  }
}

/**
 * Tell the requester the verdict — the only way they learn it, since an
 * honoured request takes the document (and its row) with it. `docTitle` is
 * passed in because on the delete path the node is already gone by now.
 */
export async function notifyDeletionResolved(params: {
  nestId: string;
  nodeId: string;
  docTitle: string;
  outcome: "deleted" | "declined";
  requestedBy: string;
  resolvedBy: string;
  requestId: string;
  targetType?: DeletionTargetType;
  note?: string;
  baseUrl?: string;
}): Promise<void> {
  try {
    const { outcome, resolvedBy, note } = params;
    // Honouring a nest_archive request archives rather than destroys, so the
    // verdict has to say so — the requester is told what actually happened.
    const archivedInstead =
      outcome === "deleted" && params.targetType === "nest_archive";
    // A nest_archive request turned down is a "no" to an ARCHIVE ask, not a
    // deletion — the rejection verdict has to say so too, mirroring the split
    // notifyDeletionRequested already makes on the request side.
    const isArchiveRequest = params.targetType === "nest_archive";
    const verb = archivedInstead
      ? "archived"
      : outcome === "deleted"
        ? "deleted"
        : isArchiveRequest
          ? "declined the archive request for"
          : "rejected the deletion of";
    const line = `${resolvedBy} ${verb} *${params.docTitle}*${note ? ` — "${note}"` : ""}`;
    const recipient = params.requestedBy.toLowerCase();

    // The "requested" inbox row(s) this resolves are done being actionable —
    // clear them for every admin who got one, not just whoever clicked
    // approve/decline, so the ask doesn't keep reading as still-open.
    await markNotificationsReadBySubject(params.requestId, "deletion_requested");

    // An honoured NEST deletion has no inbox row to write: notifications are
    // nest-scoped and cascade with the nest that just went away. Email and the
    // connectors carry that verdict instead — they aren't rows.
    const canInbox = !(params.targetType === "nest" && outcome === "deleted");

    // Nothing to tell someone about their own click.
    if (canInbox && recipient !== resolvedBy.toLowerCase()) {
      await inboxInsert(
        params.nestId,
        [recipient],
        `deletion_${outcome}`,
        params.requestId,
        outcome === "deleted"
          ? `"${params.docTitle}" was ${archivedInstead ? "archived" : "deleted"} by ${resolvedBy} — your request was accepted`
          : `Your ${isArchiveRequest ? "archive" : "deletion"} request for "${params.docTitle}" was rejected by ${resolvedBy}${note ? ` — "${note}"` : ""}`,
      );
    }

    void dispatchEvent({
      kind: `deletion_${outcome}`,
      nestId: params.nestId,
      subjectId: params.nodeId,
      actor: resolvedBy,
      message: line,
    });
    void notifyNestEvent(
      params.nestId,
      `${outcome === "deleted" ? ":wastebasket:" : ":no_entry_sign:"} ${line}`,
      undefined,
      // Verdict emails the requester directly (below), not the team inbox.
      { skipEmail: true },
    );
    if (recipient !== resolvedBy.toLowerCase()) {
      // A deleted document has no link left to offer — the nest does.
      const link = params.baseUrl
        ? `${params.baseUrl}/?nest=${encodeURIComponent(params.nestId)}`
        : "";
      void sendEmailToRecipient(recipient, {
        // The email has to agree with the inbox row and the channel line above:
        // an honoured archive is not a deletion, and the deletion template says
        // the nest is gone.
        status: archivedInstead
          ? "deletion_archived"
          : outcome === "deleted"
            ? "deletion_deleted"
            : "deletion_declined",
        docTitle: params.docTitle,
        path: params.nestId,
        link: outcome === "deleted" ? link : undefined,
        actor: resolvedBy,
        note: note || null,
      });
    }
  } catch (err) {
    console.error(
      "[notify] deletion verdict fan-out failed",
      params.nestId,
      params.nodeId,
      err,
    );
  }
}

export async function requestDeletion(params: {
  nestId: string;
  /** Node id, folder path, or nest id — see `targetType`. */
  nodeId: string;
  targetType?: DeletionTargetType;
  requestedBy: string;
  reason: string;
  /** Request origin, for building the notification's document link. */
  baseUrl?: string;
}): Promise<DeletionRequest> {
  const db = getDb();
  const targetType = params.targetType || "document";
  const noun =
    targetType === "document" ? "node" : targetType === "folder" ? "folder" : "nest";
  // A nest and a nest_archive request target the same nest id and can both be
  // open, so the clash message has to name which one is already there.
  const kind =
    targetType === "nest_archive" ? "An archive request" : "A deletion request";
  const existing = await db.get(
    "SELECT id FROM deletion_requests WHERE nest_id = ? AND node_id = ? AND target_type = ? AND status = 'pending'",
    [params.nestId, params.nodeId, targetType],
  );
  if (existing) {
    throw new ConflictError(`${kind} is already pending for this ${noun}`);
  }

  const id = uuid();
  try {
    await db.run(
      `INSERT INTO deletion_requests (id, nest_id, node_id, target_type, requested_by, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.nestId,
        params.nodeId,
        targetType,
        params.requestedBy,
        params.reason,
      ],
    );
  } catch (err) {
    // The partial unique index is the backstop for two concurrent flags racing
    // past the check above — same answer as the check, not a 500. Log first:
    // any OTHER insert failure (FK, connection drop) would otherwise be
    // reported to the user as a misleading "already pending".
    console.error(
      "[deletion] request insert failed",
      params.nestId,
      params.nodeId,
      err,
    );
    throw new ConflictError(`${kind} is already pending for this ${noun}`);
  }
  const request = (await getDeletionRequest(id))!;
  await notifyDeletionRequested(request, params.baseUrl);
  return request;
}

/** The node's most recent request, whatever its state. Drives the document
 *  badge: pending hides the flag affordance, declined tells the person who
 *  asked what the answer was — without it a decline is silent. */
export async function getLatestDeletionRequest(
  nestId: string,
  nodeId: string,
): Promise<DeletionRequest | null> {
  const db = getDb();
  const row = (await db.get(
    `SELECT * FROM deletion_requests WHERE nest_id = ? AND node_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    [nestId, nodeId],
  )) as any;
  return row ? rowToDeletionRequest(row) : null;
}

export async function getDeletionRequest(
  id: string,
): Promise<DeletionRequest | null> {
  const db = getDb();
  const row = (await db.get(
    "SELECT * FROM deletion_requests WHERE id = ?",
    [id],
  )) as any;
  return row ? rowToDeletionRequest(row) : null;
}

export async function listDeletionRequests(params: {
  nestId?: string;
  /** Cross-nest scope for the /me/work inbox — the caller's visible nests. */
  nestIds?: string[];
  /** "all" returns pending + declined — one call for a client that badges
   *  both states (a declined flag is how the requester learns the answer). */
  status?: "pending" | "declined" | "all";
}): Promise<DeletionRequest[]> {
  const db = getDb();
  const status = params.status || "pending";
  const where: string[] = [];
  const args: any[] = [];
  if (params.nestId) {
    where.push("nest_id = ?");
    args.push(params.nestId);
  }
  if (params.nestIds) {
    // Empty set = no visible nests. Short-circuit rather than emit `IN ()`.
    if (params.nestIds.length === 0) return [];
    where.push(`nest_id IN (${params.nestIds.map(() => "?").join(",")})`);
    args.push(...params.nestIds);
  }
  if (status !== "all") {
    where.push("status = ?");
    args.push(status);
  }
  const rows = (await db.all(
    `SELECT * FROM deletion_requests${
      where.length ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY created_at DESC`,
    args,
  )) as any[];
  if (rows.length === 0) return [];
  // Same reason the review queue resolves titles: the DB only stores node ids
  // like "nodes/api-rate-limits", and rendering those raw leaks storage paths.
  // One title map per nest — the queue can span nests via nestIds. Folder and
  // nest targets resolve their own label (no document to look up).
  const titlesByNest = new Map<string, Map<string, string>>();
  for (const nid of new Set(rows.map((r) => r.nest_id as string))) {
    titlesByNest.set(nid, await buildTitleMap(nid));
  }
  const out: DeletionRequest[] = [];
  for (const r of rows) {
    const request = rowToDeletionRequest(r);
    out.push({
      ...request,
      title: await deletionTargetTitle(request, titlesByNest.get(r.nest_id)),
    });
  }
  return out;
}

/**
 * Drop a request that was honoured. A document's row is purged with the rest
 * of its node-keyed rows by deleteNode, and a nest's cascades with the nest —
 * a folder is neither, so its row is removed here. Same end state for all
 * three: an honoured request leaves the queue rather than lingering resolved.
 */
export async function dropDeletionRequest(id: string): Promise<void> {
  await getDb().run("DELETE FROM deletion_requests WHERE id = ?", [id]);
}

/** Withdraw a pending deletion request. Only the original requester may do so.
 *  Returns null if the request doesn't exist, isn't pending, or belongs to
 *  another user. The row is deleted — unlike decline, there's no verdict to
 *  record when someone changes their own mind. */
export async function withdrawDeletionRequest(params: {
  nestId: string;
  id: string;
  withdrawnBy: string;
}): Promise<DeletionRequest | null> {
  const db = getDb();
  const pending = await getDeletionRequest(params.id);
  if (
    !pending ||
    pending.nestId !== params.nestId ||
    pending.status !== "pending" ||
    pending.requestedBy.toLowerCase() !== params.withdrawnBy.toLowerCase()
  ) {
    return null;
  }
  await db.run("DELETE FROM deletion_requests WHERE id = ?", [params.id]);
  return pending;
}

/** Decline a pending request, keeping the row (and the note) as the record.
 *  Returns null when it is already resolved or belongs to another nest. */
export async function declineDeletion(params: {
  nestId: string;
  id: string;
  declinedBy: string;
  note: string;
  /** Request origin, for building the notification's document link. */
  baseUrl?: string;
}): Promise<DeletionRequest | null> {
  const db = getDb();
  const pending = await getDeletionRequest(params.id);
  if (!pending || pending.nestId !== params.nestId || pending.status !== "pending") {
    return null;
  }
  // The read above and this write aren't atomic, so two declines can both pass
  // it — the `status = 'pending'` predicate lets exactly one through. Without
  // checking `changes`, the loser would also notify, telling the requester it
  // was declined by the wrong admin with the wrong note.
  const { changes } = await db.run(
    `UPDATE deletion_requests
       SET status = 'declined', resolved_by = ?, resolved_at = ${nowExpr(db)},
           resolution_note = ?
     WHERE id = ? AND status = 'pending'`,
    [params.declinedBy, params.note, params.id],
  );
  if (changes === 0) return null;
  const declined = await getDeletionRequest(params.id);
  if (declined) {
    await notifyDeletionResolved({
      nestId: params.nestId,
      nodeId: declined.nodeId,
      docTitle: await deletionTargetTitle(declined),
      outcome: "declined",
      requestedBy: declined.requestedBy,
      resolvedBy: params.declinedBy,
      requestId: declined.id,
      targetType: declined.targetType,
      note: params.note,
      baseUrl: params.baseUrl,
    });
  }
  return declined;
}

function rowToDeletionRequest(row: any): DeletionRequest {
  return {
    id: row.id,
    nestId: row.nest_id,
    nodeId: row.node_id,
    targetType: (row.target_type || "document") as DeletionTargetType,
    requestedBy: row.requested_by,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by || undefined,
    resolvedAt: row.resolved_at || undefined,
    resolutionNote: row.resolution_note || undefined,
  };
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
