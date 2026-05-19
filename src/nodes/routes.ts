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

  let node: ContextNode = {
    id,
    filePath: "",
    frontmatter: {
      title: body.title,
      type: (body.type as any) || "document",
      tags,
      status: (body.status as any) || initialStatus,
      version: 1,
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

  // Engine-native version snapshot to .versions/{slug}/ (history.yaml +
  // v1.md keyframe). Wrapped so a versioning failure can't roll back
  // the document write the user already saw succeed.
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
    status: initialStatus as any,
    tags,
  });

  // If auto-approved (no stewards), pin as approved version + run engine
  // publish so the on-disk file gets a checksum + status:published.
  // Without this, drift detection can't fire on subsequent local edits
  // (detectDrift returns drifted=false when frontmatter.checksum is absent).
  //
  // The engine bumps version (v1 → v2) as a side effect; we record that
  // bump under a `system:auto-publish:` author marker so it's invisible
  // to UI conflict detection. UI keeps seeing v1 (user version), sends
  // X-Base-Version: 1 on the next save, and checkConflict passes.
  if (initialStatus === "approved") {
    try {
      const result = await safePublishDocument(storage, id, {
        editedBy: authorEmail,
        note: "Auto-approved on create (no stewards configured)",
      });
      const engineVersion = result.node.frontmatter.version || 2;
      versions.createVersion({
        nestId,
        nodeId: id,
        version: engineVersion,
        content: result.node.body || "",
        author: versions.systemAuthor(authorEmail),
        status: "approved",
        tags,
      });
      versions.setApprovedVersion(nestId, id, 1, authorEmail);
    } catch (err) {
      console.error("publishDocument failed (node create auto-approve)", err);
      versions.setApprovedVersion(nestId, id, 1, authorEmail);
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
      canApprove: r.steward.canApprove,
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

  // Bump version number
  const currentVersion = versions.getCurrentVersion(nestId, nodeId);
  const newVersion = currentVersion + 1;
  node = {
    ...node,
    frontmatter: {
      ...node.frontmatter,
      version: newVersion,
      updated_at: new Date().toISOString(),
    },
  };

  // Strip undefined frontmatter values
  const fm = Object.fromEntries(
    Object.entries(node.frontmatter).filter(([, v]) => v !== undefined),
  );
  node = { ...node, frontmatter: fm as any };

  const serialized = serializeDocument(node);
  await storage.writeDocument(nodeId, serialized);

  // Track the new version
  const authorEmail = getUserEmail(c);
  const hasStewards = isStewardshipEnabled(nestId);
  const currentTags = (node.frontmatter.tags || []) as string[];
  // Keep tag index in sync with the latest frontmatter tags.
  syncNodeTags(nestId, nodeId, currentTags);

  // Engine-native version snapshot — appends history.yaml + writes a
  // keyframe at the configured interval so older approved bodies stay
  // recoverable via reconstructVersion() even after the author edits
  // past them on disk. Failure here is logged but doesn't abort the
  // edit; the SQLite governance row below is the canonical record.
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
    status: hasStewards ? "draft" : "approved",
    tags: currentTags,
    changeNote: body.changeNote,
  });

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

  // If no stewards, auto-approve the new version + run engine publish so
  // the on-disk file gets a fresh checksum. Without this, drift detection
  // stays blind to subsequent local edits.
  //
  // Engine bumps version (e.g. v2 → v3) as a side effect; we record that
  // bump under a `system:auto-publish:` author marker so UI conflict
  // detection ignores it. UI keeps seeing newVersion (the user-side bump
  // it just made), sends X-Base-Version: newVersion next time, and
  // checkConflict matches against the same user-version row.
  if (!hasStewards) {
    try {
      const result = await safePublishDocument(storage, nodeId, {
        editedBy: authorEmail,
        note: body.changeNote || "Auto-approved on edit (no stewards)",
      });
      const engineVersion = result.node.frontmatter.version || newVersion + 1;
      versions.createVersion({
        nestId,
        nodeId,
        version: engineVersion,
        content: result.node.body || "",
        author: versions.systemAuthor(authorEmail),
        status: "approved",
        tags: currentTags,
        changeNote: body.changeNote,
      });
      versions.setApprovedVersion(nestId, nodeId, newVersion, authorEmail);
    } catch (err) {
      console.error("publishDocument failed (node patch auto-approve)", err);
      versions.setApprovedVersion(nestId, nodeId, newVersion, authorEmail);
    }
  }

  return c.json({ node: toNodeResponse(node), version: newVersion });
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
