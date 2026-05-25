import { Hono } from "hono";
import { serializeDocument } from "@promptowl/contextnest-engine";
import type { ContextNode } from "@promptowl/contextnest-engine";
import { safePublishDocument } from "../governance/safe-publish.js";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "./engine.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { trackEvent } from "../telemetry/tracker.js";
import { getDb } from "../db/client.js";
import * as versions from "../governance/version-service.js";
import * as stewardship from "../governance/stewardship-service.js";
import { syncNodeTags, removeNodeFromTagIndex } from "../governance/tag-index-service.js";
import {
  resolveCallerEmail,
  canReadNode,
  filterAccessible,
} from "../governance/access-guard.js";
import { isStewardshipEnabled } from "../nests/service.js";
import {
  scanDocumentForDrift,
  getPendingChange,
  loadLatestApprovedNode,
} from "../governance/external-edit-service.js";

export const nodeRoutes = new Hono<AuthEnv>();

function toNodeResponse(node: ContextNode) {
  return {
    id: node.id,
    title: node.frontmatter.title,
    type: node.frontmatter.type || "document",
    tags: node.frontmatter.tags || [],
    // Widen to string so callers can layer review-workflow states like
    // "pending_review" / "rejected" on top of the on-disk frontmatter
    // status. The engine's Status enum only knows draft/approved.
    status: (node.frontmatter.status || "draft") as string,
    version: node.frontmatter.version || 1,
    author: node.frontmatter.author,
    description: node.frontmatter.description,
    created_at: node.frontmatter.created_at,
    updated_at: node.frontmatter.updated_at,
    content: node.body,
    pendingChange: node.pendingChange ?? undefined,
  };
}

// GET /nests/:nestId/nodes
nodeRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const { storage } = engineCache.get(nestId);
  const documents = await storage.discoverDocuments();
  const userEmail = resolveCallerEmail(c.get("userId"));
  const accessible = filterAccessible(nestId, userEmail, documents);

  const pendingByDoc = new Map<string, Awaited<ReturnType<typeof getPendingChange>>>();
  await Promise.all(
    accessible.map(async (doc) => {
      try {
        pendingByDoc.set(doc.id, await getPendingChange(nestId, doc.id));
      } catch {
        pendingByDoc.set(doc.id, null);
      }
    }),
  );

  return c.json({
    count: accessible.length,
    nodes: accessible.map((doc) => {
      const r = toNodeResponse(doc);
      const pending = pendingByDoc.get(doc.id);
      if (pending) {
        r.pendingChange = pending;
        r.status = "external_edit_pending";
      } else {
        // Workflow status is computed entirely from the DB so the .md
        // frontmatter stays stable across draft → pending → approved
        // cycles. See getDisplayStatus() for the resolution order.
        r.status = versions.getDisplayStatus(nestId, r.id);
      }
      return r;
    }),
  });
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
  const { storage, versions: versionManager } = engineCache.get(nestId);

  const slug = body.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const id = `nodes/${slug}`;
  const now = new Date().toISOString();
  const tags =
    body.tags?.map((t) => (t.startsWith("#") ? t : `#${t}`)) || [];

  // Determine initial status: if stewards exist, start as draft; otherwise auto-approve
  const hasStewards = isStewardshipEnabled(nestId);
  const initialStatus = hasStewards ? "draft" : "approved";

  // For no-stewards: start at v=0 so the engine's publish bump lands at
  // v=1 (engine does currentVersion+1). Otherwise v=1 → publish writes
  // v=2 and the first version the user sees in history is v=2.
  // Stewards path keeps v=1 since no publish runs on create.
  const initialVersion = hasStewards ? 1 : 0;

  let node: ContextNode = {
    id,
    filePath: "",
    frontmatter: {
      title: body.title,
      type: (body.type as any) || "document",
      tags,
      status: (body.status as any) || initialStatus,
      version: initialVersion,
      created_at: now,
      updated_at: now,
      metadata: {
        owners: ["*"],
        scope: body.scope || "team",
      },
    },
    body: body.content,
    rawContent: "",
  };

  const serialized = serializeDocument(node);
  await storage.writeDocument(id, serialized);

  // Sync tag index — resolver joins against node_tag_index.
  syncNodeTags(nestId, id, tags);

  // Track version
  const authorEmail = getUserEmail(c);

  if (hasStewards) {
    // Stewards-on: engine writes a v=1 keyframe so future reviewer
    // approval / publish has a base to diff against. governance row
    // mirrors at v=1 status='draft'. No publish until reviewer approves.
    try {
      await versionManager.createVersion(node, authorEmail);
    } catch (err) {
      console.error("VersionManager.createVersion failed (node create)", err);
    }
    versions.createVersion({
      nestId,
      nodeId: id,
      version: 1,
      content: body.content,
      author: authorEmail,
      status: "draft",
      tags,
    });
  } else {
    // No-stewards: publish immediately so the engine bumps frontmatter
    // + writes a fresh keyframe. Single governance row at the bumped
    // version with status='published' keeps DB and disk in lockstep —
    // the prior dual-write (user 'approved' + system 'auto-publish')
    // collided with the next user edit on UNIQUE(node, version).
    try {
      const result = await safePublishDocument(storage, id, {
        editedBy: authorEmail,
        note: "Auto-published on create (no stewards configured)",
      });
      const publishedVersion = result.node.frontmatter.version || 2;
      versions.createVersion({
        nestId,
        nodeId: id,
        version: publishedVersion,
        content: result.node.body || "",
        author: authorEmail,
        status: "published",
        tags,
      });
      versions.setApprovedVersion(nestId, id, publishedVersion, authorEmail);
      node = result.node;
    } catch (err) {
      console.error("publishDocument failed (node create auto-publish)", err);
      // Fallback: record the user's v=1 write as a draft so the doc is
      // not invisible to governance. Reviewer/admin can re-publish later.
      versions.createVersion({
        nestId,
        nodeId: id,
        version: 1,
        content: body.content,
        author: authorEmail,
        status: "draft",
        tags,
      });
    }
  }

  trackEvent("node.create", { nestId, nodeId: id });

  // Resolve stewards for the response
  const resolved = stewardship.resolveStewardsForNode(nestId, id);

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
  const { storage } = engineCache.get(nestId);

  const userEmail = resolveCallerEmail(c.get("userId"));
  if (!canReadNode(nestId, nodeId, userEmail)) {
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
  // Resolved-from-DB workflow status; on-disk frontmatter status is
  // ignored entirely so the file never gets rewritten on workflow
  // transitions.
  response.status = node.pendingChange
    ? "external_edit_pending"
    : versions.getDisplayStatus(nestId, nodeId);
  return c.json({ node: response });
});

// PATCH /nests/:nestId/nodes/:nodeId{.+}
nodeRoutes.patch("/:nodeId{.+}", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const { storage, versions: versionManager } = engineCache.get(nestId);
  const body = await c.req.json<{
    content?: string;
    append?: string;
    tags?: string[];
    status?: string;
    title?: string;
    changeNote?: string;
  }>();

  // ── Conflict detection via X-Base-Version header ──
  const baseVersionHeader = c.req.header("X-Base-Version");
  if (baseVersionHeader) {
    const baseVersion = parseInt(baseVersionHeader, 10);
    const conflict = versions.checkConflict(nestId, nodeId, baseVersion);
    if (conflict.conflict) {
      // Return 409 with full conflict info + the user's rejected content
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

  let node: ContextNode;
  try {
    node = await storage.readDocument(nodeId);
  } catch {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }

  if (body.content !== undefined) {
    node = { ...node, body: body.content };
  }
  if (body.append) {
    node = { ...node, body: (node.body || "") + "\n\n" + body.append };
  }
  if (body.tags) {
    const newTags = body.tags.map((t) => (t.startsWith("#") ? t : `#${t}`));
    const merged = [...new Set([...(node.frontmatter.tags || []), ...newTags])];
    node = { ...node, frontmatter: { ...node.frontmatter, tags: merged } };
  }
  if (body.status) {
    node = {
      ...node,
      frontmatter: { ...node.frontmatter, status: body.status as any },
    };
  }
  if (body.title) {
    node = {
      ...node,
      frontmatter: { ...node.frontmatter, title: body.title },
    };
  }

  const authorEmail = getUserEmail(c);
  const hasStewards = isStewardshipEnabled(nestId);
  const currentTags = (node.frontmatter.tags || []) as string[];

  // Editing past a pending review withdraws it — the steward's queue
  // entry referenced the old version, which is now stale. The new
  // version starts a fresh draft cycle; author re-submits when ready.
  // Server enforces this even though the UI also locks editing during
  // pending: API clients (MCP, CLI) hit the same code path.
  const { cancelReview, getPendingReview } = await import(
    "../governance/review-service.js"
  );
  if (getPendingReview(nestId, nodeId)) {
    cancelReview({ nestId, nodeId, cancelledBy: authorEmail });
  }

  let responseVersion: number;
  if (hasStewards) {
    // Stewards-on: bump version explicitly, write through engine
    // history, record a draft row. Reviewer publishes later.
    const currentVersion = versions.getCurrentVersion(nestId, nodeId);
    const newVersion = currentVersion + 1;
    node = {
      ...node,
      frontmatter: {
        ...node.frontmatter,
        version: newVersion,
        updated_at: new Date().toISOString(),
        // Strip the stale published-state checksum — the body just
        // changed, so leaving the old hash would make the next GET (with
        // verifyChecksum: true) flag the file as an external edit even
        // though *this* app wrote it. Engine treats absent checksum as
        // "no baseline" and skips drift detection until publish runs.
        checksum: undefined,
      },
    };
    const fm = Object.fromEntries(
      Object.entries(node.frontmatter).filter(([, v]) => v !== undefined),
    );
    node = { ...node, frontmatter: fm as any };

    await storage.writeDocument(nodeId, serializeDocument(node));
    syncNodeTags(nestId, nodeId, currentTags);

    try {
      await versionManager.createVersion(node, authorEmail, {
        note: body.changeNote,
      });
    } catch (err) {
      console.error("VersionManager.createVersion failed (node patch)", err);
    }

    versions.createVersion({
      nestId,
      nodeId,
      version: newVersion,
      content: node.body || "",
      author: authorEmail,
      status: "draft",
      tags: currentTags,
      changeNote: body.changeNote,
    });
    responseVersion = newVersion;
  } else {
    // No stewards: skip the user-side version bump + the standalone
    // engine history entry. publishDocument handles both — it reads
    // disk, bumps version once, writes file + records the diff entry.
    // ONE governance row per save at the engine's bumped version with
    // status='published' keeps DB and disk in lockstep.
    node = {
      ...node,
      frontmatter: {
        ...node.frontmatter,
        updated_at: new Date().toISOString(),
        // Drop the prior published-state checksum before the interim
        // write — publish recomputes it from the new body, but if
        // publish errors out the file would otherwise be left with new
        // body + stale checksum and drift on next read.
        checksum: undefined,
      },
    };
    const fm = Object.fromEntries(
      Object.entries(node.frontmatter).filter(([, v]) => v !== undefined),
    );
    node = { ...node, frontmatter: fm as any };

    await storage.writeDocument(nodeId, serializeDocument(node));
    syncNodeTags(nestId, nodeId, currentTags);

    let publishedVersion = (node.frontmatter.version || 0) + 1;
    try {
      const result = await safePublishDocument(storage, nodeId, {
        editedBy: authorEmail,
        note: body.changeNote || "Auto-published on edit (no stewards)",
      });
      publishedVersion = result.node.frontmatter.version || publishedVersion;
      node = result.node;
    } catch (err) {
      console.error("publishDocument failed (node patch auto-publish)", err);
    }
    versions.createVersion({
      nestId,
      nodeId,
      version: publishedVersion,
      content: node.body || "",
      author: authorEmail,
      status: "published",
      tags: currentTags,
      changeNote: body.changeNote,
    });
    versions.setApprovedVersion(nestId, nodeId, publishedVersion, authorEmail);
    responseVersion = publishedVersion;
  }

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
