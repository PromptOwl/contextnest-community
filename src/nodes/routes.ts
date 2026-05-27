import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "./engine.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { trackEvent } from "../telemetry/tracker.js";
import { getDb } from "../db/client.js";
import * as versions from "../governance/version-service.js";
import * as stewardship from "../governance/stewardship-service.js";
import * as reviews from "../governance/review-service.js";
import { syncNodeTags, removeNodeFromTagIndex } from "../governance/tag-index-service.js";
import {
  resolveCallerEmail,
  canReadNode,
} from "../governance/access-guard.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { isPublicReader } from "../shared/access.js";
import {
  scanDocumentForDrift,
  getPendingChange,
  loadLatestApprovedNode,
} from "../governance/external-edit-service.js";
import {
  createNode,
  updateNode,
  listNodesForCaller,
  toNodeResponse,
  bodyOnly,
} from "./service.js";

export const nodeRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/nodes
nodeRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const nodes = await listNodesForCaller(nestId, userId);
  return c.json({ count: nodes.length, nodes });
});

// POST /nests/:nestId/nodes
nodeRoutes.post("/", async (c) => {
  const body = await c.req.json<{
    title?: string;
    content?: string;
    type?: string;
    tags?: string[];
    scope?: string;
    status?: string;
  }>();

  if (!body.title || !body.content) {
    throw new ValidationError("title and content are required");
  }

  const nestId = c.req.param("nestId")!;
  const authorEmail = getUserEmail(c);
  const { node } = await createNode(
    nestId,
    {
      title: body.title,
      content: body.content,
      type: body.type,
      tags: body.tags,
      scope: body.scope,
      status: body.status,
    },
    authorEmail,
  );

  // Resolve stewards for the response
  const resolved = stewardship.resolveStewardsForNode(nestId, node.id);

  return c.json({
    node: toNodeResponse(node),
    stewards: resolved.length > 0
      ? resolved.map((r) => ({
        email: r.steward.userEmail,
        role: r.steward.role,
        source: r.source,
      }))
      : undefined,
  }, 201);
});

// ─── Governance GET endpoints (before the catch-all) ────────────────
// These must be registered BEFORE the /:nodeId{.+} catch-all.
// Import governance services inline to avoid circular deps.

// GET /nests/:nestId/nodes/:nodeId/stewards
nodeRoutes.get("/:nodeId{.+?}/stewards", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const { resolveStewardsWithFallback } = await import("../governance/stewardship-service.js");
  const { stewards, fallbackToOwner, ownerEmail } = resolveStewardsWithFallback(
    nestId,
    nodeId,
  );
  return c.json({
    nodeId,
    stewards: stewards.map((r: any) => ({
      email: r.steward.userEmail,
      role: r.steward.role,
      scope: r.steward.scope,
      source: r.source,
      priority: r.priority,
    })),
    fallbackToOwner,
    ownerEmail,
  });
});

// GET /nests/:nestId/nodes/:nodeId/versions
nodeRoutes.get("/:nodeId{.+?}/versions", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const { getVersions, getApprovedVersion } = await import("../governance/version-service.js");
  const allVersions = getVersions(nestId, nodeId);
  const approved = getApprovedVersion(nestId, nodeId);

  // Enrich each version with the resolver (approver/rejecter) so the UI
  // can show "approved by X" next to the row. We pull the latest
  // resolution per version from review_requests; node_versions itself
  // doesn't carry approver email.
  const db = getDb();
  const resolutions = db
    .prepare(
      `SELECT version, status, resolved_by, resolved_at
         FROM review_requests
        WHERE nest_id = ? AND node_id = ?
          AND status IN ('approved', 'rejected')
          AND resolved_by IS NOT NULL
        ORDER BY resolved_at DESC`,
    )
    .all(nestId, nodeId) as Array<{
      version: number;
      status: string;
      resolved_by: string;
    }>;
  const byVersion = new Map<number, { status: string; resolvedBy: string }>();
  for (const r of resolutions) {
    if (!byVersion.has(r.version)) {
      byVersion.set(r.version, { status: r.status, resolvedBy: r.resolved_by });
    }
  }
  const enriched = allVersions.map((v) => {
    const r = byVersion.get(v.version);
    return r ? { ...v, resolvedBy: r.resolvedBy, resolutionStatus: r.status } : v;
  });

  return c.json({
    versions: enriched,
    approvedVersion: approved,
    currentVersion: allVersions[0]?.version || 0,
  });
});

// GET /nests/:nestId/nodes/:nodeId/reviews
nodeRoutes.get("/:nodeId{.+?}/reviews", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const { getReviewHistory } = await import("../governance/review-service.js");
  const history = getReviewHistory(nestId, nodeId);
  return c.json({ reviews: history });
});

// GET /nests/:nestId/nodes/:nodeId{.+} — read a single node (catch-all, must be LAST)
nodeRoutes.get("/:nodeId{.+}", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const { storage, versions: versionManager } = engineCache.get(nestId);

  const userId = c.get("userId");
  const userEmail = resolveCallerEmail(userId);
  if (!canReadNode(nestId, nodeId, userId, userEmail)) {
    return c.json(
      { error: "Access denied — no steward assignment for this node" },
      403,
    );
  }

  let node;
  try {
    // verifyChecksum=true triggers drift detection on read; on drift the
    // engine returns the last-approved canonical body with pendingChange
    // attached (hootie-inbox-spec §4.2). We then stage the drift as a
    // suggestion so the next pendingChange lookup resolves a real id.
    node = await storage.readDocument(nodeId, { verifyChecksum: true });
  } catch {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }
  if (node.pendingChange) {
    try {
      await scanDocumentForDrift(nestId, nodeId, userEmail || "system:read");
      const refreshed = await getPendingChange(nestId, nodeId);
      if (refreshed) node.pendingChange = refreshed;
    } catch (err) {
      console.error("[external-edit] stage-on-read failed:", err);
    }
    // Engine returns the nearest *keyframe* body (every 10 versions) as
    // the approved baseline — at v=5 that's the v=1 keyframe, so the
    // editor would render the original draft body underneath the drift
    // banner. Reconstruct the actual latest version from history.yaml
    // so the user sees the current approved state, with the drift shown
    // separately via the suggestion patch.
    try {
      const latest = await loadLatestApprovedNode(nestId, nodeId);
      if (latest) {
        node = { ...latest, pendingChange: node.pendingChange };
      }
    } catch (err) {
      console.error("[external-edit] reconstruct-latest failed:", err);
    }
  }
  const response = toNodeResponse(node);

  // Public readers see approved version body only.
  if (isPublicReader(nestId, userId)) {
    const approved = versions.getApprovedVersion(nestId, nodeId);
    if (approved != null) {
      try {
        const raw = await versionManager.reconstructVersion(
          nodeId,
          approved,
        );
        response.content = bodyOnly(nodeId, raw);
      } catch (err) {
        console.error(
          "reconstructVersion failed (public single)",
          nodeId,
          approved,
          err,
        );
        response.content = "";
      }
      response.version = approved;
      response.status = "published";
      return c.json({ node: response });
    }
  }

  // Resolved-from-DB workflow status; on-disk frontmatter status is
  // ignored entirely so the file never gets rewritten on workflow
  // transitions.
  response.status = node.pendingChange
    ? "external_edit_pending"
    : versions.getDisplayStatus(nestId, nodeId);
  // Surface the pending review's submitter so the UI can hide the
  // approve/reject affordance from that user (SoD). Server enforces too.
  if (response.status === "pending_review") {
    const pending = reviews.getPendingReview(nestId, nodeId);
    (response as any).pendingReviewBy = pending?.requestedBy ?? null;
  }
  return c.json({ node: response });
});

// PATCH /nests/:nestId/nodes/:nodeId{.+}
nodeRoutes.patch("/:nodeId{.+}", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const body = await c.req.json<{
    content?: string;
    append?: string;
    tags?: string[];
    status?: string;
    title?: string;
    changeNote?: string;
  }>();

  // Conflict detection via X-Base-Version header — REST-only contract.
  const baseVersionHeader = c.req.header("X-Base-Version");
  if (baseVersionHeader) {
    const baseVersion = parseInt(baseVersionHeader, 10);
    const conflict = versions.checkConflict(nestId, nodeId, baseVersion);
    if (conflict.conflict) {
      return c.json(
        {
          error: "Version conflict",
          your_version: baseVersion,
          current_version: conflict.currentVersion,
          updated_by: conflict.updatedBy,
          updated_at: conflict.updatedAt,
          rejected_content: body.content || body.append || null,
        },
        409,
      );
    }
  }

  const authorEmail = getUserEmail(c);
  const { node, version: responseVersion } = await updateNode(
    nestId,
    nodeId,
    {
      content: body.content,
      append: body.append,
      tags: body.tags,
      title: body.title,
      status: body.status,
      changeNote: body.changeNote,
    },
    authorEmail,
  );

  return c.json({ node: toNodeResponse(node), version: responseVersion });
});

// DELETE /nests/:nestId/nodes/:nodeId{.+}
nodeRoutes.delete("/:nodeId{.+}", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const { storage } = engineCache.get(nestId);

  try {
    await storage.deleteDocument(nodeId);
  } catch {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }

  removeNodeFromTagIndex(nestId, nodeId);

  // Purge governance rows tied to this node id. Without this, recreating
  // a doc with the same title (→ same slug → same node id) hits a UNIQUE
  // constraint on node_versions(nest_id, node_id, version) because the
  // old version rows still exist. We also drop pending/historic review
  // requests and the approved-version pin so the recreated doc starts
  // from a clean slate.
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      "DELETE FROM node_versions WHERE nest_id = ? AND node_id = ?",
    ).run(nestId, nodeId);
    db.prepare(
      "DELETE FROM review_requests WHERE nest_id = ? AND node_id = ?",
    ).run(nestId, nodeId);
    db.prepare(
      "DELETE FROM approved_versions WHERE nest_id = ? AND node_id = ?",
    ).run(nestId, nodeId);
    // Document-scoped steward rows pin to this exact node_pattern. Tag
    // and nest-scoped stewards stay — they govern the whole nest, not
    // this single doc. Without this purge, recreating a doc with the
    // same slug silently inherits the prior doc's reviewer assignments.
    db.prepare(
      `DELETE FROM stewards
       WHERE nest_id = ? AND scope = 'document' AND node_pattern = ?`,
    ).run(nestId, nodeId);
  })();

  trackEvent("node.delete", { nestId, nodeId });

  return c.json({ deleted: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────

function getUserEmail(c: any): string {
  const userId = c.get("userId");
  const db = getDb();
  const user = db
    .prepare("SELECT email FROM users WHERE id = ?")
    .get(userId) as { email: string } | undefined;
  return user?.email || "anonymous@localhost";
}
