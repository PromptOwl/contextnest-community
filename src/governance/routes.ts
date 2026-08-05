/**
 * Governance Routes — API endpoints for stewardship, reviews, and versions.
 *
 * Two route sets:
 * - governanceRoutes: mounted at /nests/:nestId (stewards, review-queue)
 * - governanceNodeRoutes: mounted at /nests/:nestId/nodes BEFORE nodeRoutes catch-all
 */

import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { ValidationError, ConflictError } from "../shared/errors.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { getDb } from "../db/client.js";
import * as stewardship from "./stewardship-service.js";
import * as reviews from "./review-service.js";
import * as feed from "./feed-service.js";
import * as comments from "./comment-service.js";
import * as versions from "./version-service.js";
import * as externalEdits from "./external-edit-service.js";
import { loadStewardsConfig } from "./stewards-parser.js";
import { isSuperAdmin } from "./access-service.js";
import { engineCache } from "../nodes/engine.js";
import {
  bodyOnly,
  deleteNode,
  deleteFolder,
  isIdUnderFolder,
} from "../nodes/service.js";
import { deleteNest } from "../nests/service.js";
import { canReadNode, resolveCallerEmail } from "./access-guard.js";
import { handleAnnotationReply } from "../annotations/routes.js";

// ═════════════════════════════════════════════════════════════════════════
// Nest-level routes (mounted at /:nestId)
// ═════════════════════════════════════════════════════════════════════════

/** Parse a ?limit= query into a sane bound. A non-numeric value (e.g. "abc")
 *  is truthy, so `|| "100"` never fires and parseInt yields NaN — which then
 *  slips through `?? 100` and makes slice(0, NaN) return an empty list. Guard
 *  NaN / out-of-range explicitly and cap at 1000. */
function parseLimit(raw: string | undefined, def = 100, max = 1000): number {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n) || n < 1) return def;
  return Math.min(n, max);
}

export const governanceRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/stewards?scope=tag&search=architect
governanceRoutes.get("/stewards", async (c) => {
  const nestId = c.req.param("nestId")!;
  const scope = c.req.query("scope") as any;
  const search = c.req.query("search");
  const stewards = await stewardship.listStewards({
    nestId,
    scope: scope || undefined,
    search: search || undefined,
  });
  // Annotate each row with the user's collaborator access and merged
  // effective roles so the UI can show the full picture (a steward may also
  // be a write collaborator, etc.). Cached per email across rows.
  const cache = new Map<
    string,
    { collaboratorRole: string | null; roles: string[] }
  >();
  const enriched = [];
  for (const s of stewards) {
    const key = s.userEmail.toLowerCase();
    let merged = cache.get(key);
    if (!merged) {
      merged = {
        collaboratorRole: await stewardship.getCollaboratorRole(nestId, s.userEmail),
        roles: await stewardship.resolveUserRoles(nestId, s.userEmail),
      };
      cache.set(key, merged);
    }
    enriched.push({ ...s, ...merged });
  }
  return c.json({ stewards: enriched });
});

// POST /nests/:nestId/stewards
// Accepts two shapes:
//   1) Multi-user: { scope, documentId?|tagName?, users: [{email, role}] }
//   2) Legacy single-user (fallback): { scope, email, role, nodePattern?, tagName? }
governanceRoutes.post("/stewards", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<any>();
  const assignedBy = await getUserEmail(c);

  if (!body.scope) throw new ValidationError("scope is required");
  if (body.scope === "folder") {
    throw new ValidationError(
      "folder scope is no longer supported — use 'nest' or 'document'",
    );
  }

  // New shape: users[] array
  if (Array.isArray(body.users)) {
    const created = await stewardship.createStewardRecord({
      nestId,
      scope: body.scope,
      documentId: body.documentId,
      tagName: body.tagName,
      users: body.users,
      assignedBy,
      baseUrl: requestBaseUrl(c.req.url),
    });
    return c.json({ stewards: created }, 201);
  }

  // Legacy shape: single email
  if (!body.email) {
    throw new ValidationError("users[] or email is required");
  }
  const created = await stewardship.createStewardRecord({
    nestId,
    scope: body.scope,
    documentId: body.scope === "document" ? body.nodePattern : undefined,
    tagName: body.scope === "tag" ? body.tagName : undefined,
    users: [
      {
        email: body.email,
        role: body.role,
      },
    ],
    assignedBy,
    baseUrl: requestBaseUrl(c.req.url),
  });
  return c.json({ steward: created[0] }, 201);
});

// PATCH /nests/:nestId/stewards/:stewardId — change a steward's role and/or scope
governanceRoutes.patch("/stewards/:stewardId", async (c) => {
  const stewardId = c.req.param("stewardId")!;
  const body = await c.req.json<{
    role?: string;
    scope?: string;
    nodePattern?: string;
    tagName?: string;
  }>();
  if (!body.role && !body.scope) {
    throw new ValidationError("role or scope is required");
  }
  const steward = await stewardship.updateSteward(stewardId, {
    role: body.role as any,
    scope: body.scope as any,
    documentId: body.nodePattern,
    tagName: body.tagName,
  });
  return c.json({ steward });
});

// DELETE /nests/:nestId/stewards/:stewardId — soft-remove one row
governanceRoutes.delete("/stewards/:stewardId", async (c) => {
  const stewardId = c.req.param("stewardId")!;
  await stewardship.removeSteward(stewardId);
  return c.json({ removed: true });
});

// POST /nests/:nestId/stewards/sync
governanceRoutes.post("/stewards/sync", async (c) => {
  const nestId = c.req.param("nestId")!;
  const stewardsConfig = loadStewardsConfig(nestId);
  if (!stewardsConfig) {
    return c.json({ synced: 0, message: "No stewards.yaml found" });
  }
  const count = await stewardship.syncFromConfig(nestId, stewardsConfig);
  return c.json({ synced: count });
});

// GET /nests/:nestId/review-queue
governanceRoutes.get("/review-queue", async (c) => {
  const nestId = c.req.param("nestId")!;
  const status = c.req.query("status") || "pending";
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  const result = await reviews.getReviewQueue({
    nestId,
    status: status as any,
    limit,
    offset,
  });

  // Annotate each request with the caller's authoritative review capability
  // (the SAME check approve/reject enforce — handles admin/owner/steward scope
  // + separation-of-duties). The UI gates the Review button + queue off this
  // instead of re-deriving steward scope client-side, which diverged for
  // reviewer-stewards reaching the nest via public visibility (CU-wdqcpzudt3
  // follow-up). Cached per node across rows.
  const email = await getUserEmail(c);
  const canReviewCache = new Map<string, boolean>();
  const requests = [];
  for (const r of result.requests) {
    let canReview = canReviewCache.get(r.nodeId);
    if (canReview === undefined) {
      canReview = (await stewardship.canUserApprove(nestId, r.nodeId, email)).allowed;
      canReviewCache.set(r.nodeId, canReview);
    }
    requests.push({ ...r, canReview });
  }

  return c.json({ ...result, requests });
});

// ─── Deletion requests ──────────────────────────────────────────────────

/**
 * Owner/admin gate for the bulk deletions the middleware only holds at
 * 'write' — that tier is calibrated for ONE document (DELETE /nodes/:id).
 * Deleting a folder or a nest destroys many at once, so it sits with nest
 * management instead.
 *
 * One helper, not a check per branch: the direct route and the honour path
 * must assert the same policy, or honouring a request becomes the way around
 * the direct route. Returns an error response, or null to proceed.
 */
function denyUnlessNestManager(c: any, what: string) {
  const permission = c.get("nestPermission");
  if (permission === "owner" || permission === "admin") return null;
  return c.json(
    {
      error: `Only the nest owner or an admin can delete ${what}. Request its deletion instead, or ask an admin to action it.`,
    },
    403,
  );
}
// Anyone who can read a node may flag it for deletion (POST on the node route
// below); resolving is write-tier — the middleware already requires 'write' for
// these paths, the same gate DELETE /nodes/:id passes, so no extra check here.

// POST /nests/:nestId/delete-folder — delete a folder and every document
// under it. Owner/admin only: a folder delete is many document deletes at
// once, so it sits at the same tier as deleting the nest, not at 'write'.
governanceRoutes.post("/delete-folder", async (c) => {
  const nestId = c.req.param("nestId")!;
  const denied = denyUnlessNestManager(c, "a folder");
  if (denied) return denied;
  const body = await c.req.json<{ folder?: string }>().catch(() => ({}) as any);
  if (!body.folder?.trim()) {
    throw new ValidationError("folder is required");
  }
  const deleted = await deleteFolder(
    nestId,
    body.folder.trim(),
    await getUserEmail(c),
  );
  return c.json({ deleted: deleted.length, nodeIds: deleted });
});

// POST /nests/:nestId/request-deletion — flag a whole FOLDER or the NEST.
// Read-tier for the same reason the per-node route is (see there); the path
// suffix matches the middleware's request-deletion exception, so no new gate.
// Per-document flags keep their own route under /nodes/:nodeId.
governanceRoutes.post("/request-deletion", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req
    .json<{ targetType?: string; target?: string; reason?: string }>()
    .catch(() => ({}) as any);
  const reason = body.reason?.trim();
  if (!reason) {
    throw new ValidationError("A reason for the deletion request is required");
  }
  if (body.targetType !== "folder" && body.targetType !== "nest") {
    throw new ValidationError(
      'targetType must be "folder" or "nest" — flag a single document via POST /nests/:nestId/nodes/:nodeId/request-deletion',
    );
  }

  // Normalize the target so two people flagging "api/limits" and "/api/limits/"
  // collide on the pending index instead of raising two requests.
  const target =
    body.targetType === "nest"
      ? nestId
      : (body.target || "").trim().replace(/^\/+|\/+$/g, "").replace(/^nodes\//, "");
  if (body.targetType === "folder" && !target) {
    throw new ValidationError("target (the folder path) is required");
  }

  // A folder only exists while documents sit under it — refuse a flag on one
  // that isn't there, or the queue fills with requests that delete nothing.
  if (body.targetType === "folder") {
    const { storage } = await engineCache.get(nestId);
    const docs = await storage.discoverDocuments();
    if (!docs.some((d) => isIdUnderFolder(d.id, target))) {
      return c.json({ error: `Folder not found: ${target}` }, 404);
    }
  }

  const request = await reviews.requestDeletion({
    nestId,
    nodeId: target,
    targetType: body.targetType,
    requestedBy: await getUserEmail(c),
    reason,
    baseUrl: requestBaseUrl(c.req.url),
  });
  return c.json({ request }, 201);
});

// GET /nests/:nestId/deletion-requests?status=pending|declined
governanceRoutes.get("/deletion-requests", async (c) => {
  const nestId = c.req.param("nestId")!;
  const raw = c.req.query("status");
  const status =
    raw === "declined" || raw === "all" ? raw : "pending";
  const requests = await reviews.listDeletionRequests({ nestId, status });
  return c.json({ requests, total: requests.length });
});

// POST /nests/:nestId/deletion-requests/:id/delete — honour the request.
governanceRoutes.post("/deletion-requests/:id/delete", async (c) => {
  const nestId = c.req.param("nestId")!;
  const request = await reviews.getDeletionRequest(c.req.param("id")!);
  if (!request || request.nestId !== nestId || request.status !== "pending") {
    return c.json({ error: "Deletion request not found" }, 404);
  }
  // Resolve the label BEFORE the delete — afterwards there's no document (or
  // nest) left to read one from, and the verdict notification needs it.
  const actor = await getUserEmail(c);
  const docTitle = await reviews.deletionTargetTitle(request);

  // Honouring must clear the SAME bar as deleting the thing directly — a
  // request is not a side door around /delete-folder or DELETE /nests/:id.
  if (request.targetType === "nest" || request.targetType === "folder") {
    const denied = denyUnlessNestManager(
      c,
      request.targetType === "nest" ? "a nest" : "a folder",
    );
    if (denied) return denied;
  }

  if (request.targetType === "nest") {
    // Nest rows cascade with the nest, so the request row goes with it.
    await deleteNest(nestId);
  } else if (request.targetType === "folder") {
    await deleteFolder(nestId, request.nodeId, actor);
    // A folder isn't node-keyed, so no purge took this row — drop it here so
    // an honoured request leaves the queue like the other two kinds.
    await reviews.dropDeletionRequest(request.id);
  } else {
    // deleteNode owns the review lock + tombstone, and its purge takes this row
    // with the node's other rows — so an honoured request leaves the queue.
    await deleteNode(nestId, request.nodeId, actor);
  }
  // Only the requester can learn the outcome from a notification — the
  // document (and its request row) are gone from every other surface.
  await reviews.notifyDeletionResolved({
    nestId,
    nodeId: request.nodeId,
    docTitle,
    outcome: "deleted",
    requestedBy: request.requestedBy,
    resolvedBy: actor,
    requestId: request.id,
    targetType: request.targetType,
    baseUrl: requestBaseUrl(c.req.url),
  });
  return c.json({ deleted: true, nodeId: request.nodeId });
});

// POST /nests/:nestId/deletion-requests/:id/decline
governanceRoutes.post("/deletion-requests/:id/decline", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<{ note?: string }>().catch(() => ({}) as any);
  if (!body.note?.trim()) {
    throw new ValidationError("A note is required when declining");
  }
  const request = await reviews.declineDeletion({
    nestId,
    id: c.req.param("id")!,
    declinedBy: await getUserEmail(c),
    note: body.note.trim(),
    baseUrl: requestBaseUrl(c.req.url),
  });
  if (!request) return c.json({ error: "Deletion request not found" }, 404);
  return c.json({ request });
});

// GET /nests/:nestId/feed?filter=all|changes|comments&limit=&offset=
// Activity feed: pending change submissions (the same rows the review queue
// shows, every field intact) interleaved with annotation activity (new
// comment threads + replies), newest first. ADDITIVE sibling of
// /review-queue — that endpoint (and the MCP context_review_queue tool)
// keep their exact shape. Comment items are access-filtered to documents
// the caller can read.
governanceRoutes.get("/feed", async (c) => {
  const nestId = c.req.param("nestId")!;
  const filterRaw = c.req.query("filter");
  const filter =
    filterRaw === "changes" || filterRaw === "comments" ? filterRaw : "all";
  const limit = parseLimit(c.req.query("limit"), 50, 200);
  // Cap offset: each source over-fetches offset+limit rows for the merge, so
  // an unbounded offset would grow that window (and the sort) without bound.
  const offsetRaw = parseInt(c.req.query("offset") ?? "", 10);
  const offset =
    Number.isNaN(offsetRaw) || offsetRaw < 0
      ? 0
      : Math.min(offsetRaw, 10_000);
  const userId = c.get("userId");
  // Same identity resolution as the review-queue handler above — the feed's
  // canReview must agree with the queue's for the same caller (the
  // access-guard resolver falls back to a different anonymous identity).
  const userEmail = await getUserEmail(c);

  const result = await feed.getNestFeed({
    nestId,
    userId,
    userEmail,
    filter,
    limit,
    offset,
  });
  return c.json({ ...result, filter, limit, offset });
});

// GET /nests/:nestId/external-edits
// List pending external (direct filesystem) edits awaiting approval.
governanceRoutes.get("/external-edits", async (c) => {
  const nestId = c.req.param("nestId")!;
  const refresh = c.req.query("refresh") === "true";
  if (refresh) {
    await externalEdits.scanNestForDrift(nestId, "user:refresh");
  }
  const entries = await externalEdits.listNestExternalEdits(nestId);
  return c.json({ entries, total: entries.length });
});

// POST /nests/:nestId/external-edits/scan
// Force a drift scan and return what was newly staged.
governanceRoutes.post("/external-edits/scan", async (c) => {
  const nestId = c.req.param("nestId")!;
  const actor = await getUserEmail(c);
  const result = await externalEdits.scanNestForDrift(nestId, actor);
  return c.json(result);
});

// GET /nests/:nestId/activity
// Nest-wide activity log — who did what across every node in the nest.
governanceRoutes.get("/activity", async (c) => {
  const nestId = c.req.param("nestId")!;
  const limit = parseLimit(c.req.query("limit"));
  const activity = await comments.getActivity({ nestId, limit });
  return c.json({ activity });
});

// ═════════════════════════════════════════════════════════════════════════
// Node-level routes (mounted at /:nestId/nodes, BEFORE the CRUD catch-all)
// ═════════════════════════════════════════════════════════════════════════

export const governanceNodeRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/nodes/:nodeId/stewards
governanceNodeRoutes.get("/:nodeId{.+}/stewards", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const { stewards: resolved, fallbackToOwner, ownerEmail } =
    await stewardship.resolveStewardsWithFallback(nestId, nodeId);
  return c.json({
    nodeId,
    stewards: resolved.map((r) => ({
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
governanceNodeRoutes.get("/:nodeId{.+}/versions", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  // Same node-level gate the document read itself takes: the nest middleware
  // only clears the nest, and this route hands out every version's change log.
  // A public reader is limited to nodes with an approved version, so a doc that
  // never cleared review must not leak its drafts through its history.
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json(
      { error: "Access denied — no steward assignment for this node" },
      403,
    );
  }

  const allVersions = await versions.getVersions(nestId, nodeId);
  const approved = await versions.getApprovedVersion(nestId, nodeId);

  // getVersions returns content:"" (bodies live on disk, not the table). Attach
  // each version's stored change log — the unified diff from the version before
  // it — which is one small file read apiece. Reconstructing every body here
  // instead would replay the chain once per row and ship N full copies of the
  // document just to open the history panel; the single body a caller actually
  // previews or restores is fetched by GET .../versions/:version.
  const { versions: versionManager } = await engineCache.get(nestId);

  // Who approved/rejected each version. node_versions carries the status but
  // not the resolver's email, so the latest resolution per version comes from
  // review_requests — that is what the row's "approved by X" hint renders.
  const resolutions = (await getDb().all(
    `SELECT version, status, resolved_by
       FROM review_requests
      WHERE nest_id = ? AND node_id = ?
        AND status IN ('approved', 'rejected')
        AND resolved_by IS NOT NULL
      ORDER BY resolved_at DESC`,
    [nestId, nodeId],
  )) as Array<{ version: number; status: string; resolved_by: string }>;
  const byVersion = new Map<number, { status: string; resolvedBy: string }>();
  for (const r of resolutions) {
    if (!byVersion.has(r.version)) {
      byVersion.set(r.version, { status: r.status, resolvedBy: r.resolved_by });
    }
  }

  const enriched = await Promise.all(
    allVersions.map(async (v) => {
      const r = byVersion.get(v.version);
      const resolution = r
        ? { resolvedBy: r.resolvedBy, resolutionStatus: r.status }
        : {};
      try {
        const diff = await versionManager.getDiff(nodeId, v.version);
        return { ...v, ...resolution, diff: diff ?? undefined };
      } catch {
        return { ...v, ...resolution };
      }
    }),
  );

  return c.json({
    versions: enriched,
    approvedVersion: approved,
    currentVersion: allVersions[0]?.version || 0,
  });
});

// GET /nests/:nestId/nodes/:nodeId/versions/:version — one version's full body,
// reconstructed on demand (keyframe + replay). Split out from the list above so
// opening the history panel costs N small diff reads instead of N chain replays.
governanceNodeRoutes.get("/:nodeId{.+}/versions/:version{[0-9]+}", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const version = Number(c.req.param("version"));

  // Reconstructs a full historical body, so it takes the node read gate — a
  // public reader must not pull an unapproved version out of the chain.
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json(
      { error: "Access denied — no steward assignment for this node" },
      403,
    );
  }

  const { versions: versionManager } = await engineCache.get(nestId);
  try {
    const raw = await versionManager.reconstructVersion(nodeId, version);
    return c.json({ version, content: bodyOnly(nodeId, raw) });
  } catch (err) {
    // A version whose chain no longer replays is a real state, not a 500 —
    // the panel renders "(no content)" for it and Restore stays disabled.
    console.error("reconstructVersion failed", nestId, nodeId, version, err);
    return c.json({ version, content: null }, 200);
  }
});

// GET /nests/:nestId/nodes/:nodeId/reviews
governanceNodeRoutes.get("/:nodeId{.+}/reviews", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const history = await reviews.getReviewHistory(nestId, nodeId);
  return c.json({ reviews: history });
});

// GET /nests/:nestId/nodes/:nodeId/comments?status=open
// List comments on a node. Open to anyone with nest-read access (a reviewer
// must be able to read + leave comments without write permission).
governanceNodeRoutes.get("/:nodeId{.+}/comments", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const status = c.req.query("status") as "open" | "resolved" | undefined;
  const list = await comments.listComments(nestId, nodeId, {
    status: status === "open" || status === "resolved" ? status : undefined,
  });
  return c.json({ comments: list });
});

// POST /nests/:nestId/nodes/:nodeId/comments
// Leave a comment. Body: { body, version?, anchor?{start,end,text?}, parentId? }
governanceNodeRoutes.post("/:nodeId{.+}/comments", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  // Annotation thread replies (…/:nodeId/annotations/:threadId/comments) land
  // here too: RegExpRouter merges the greedy :nodeId across both patterns and
  // the greedy capture wins, so this route sees
  // nodeId = "<realNodeId>/annotations/<threadId>". Detect and delegate.
  const annotationReply = nodeId.match(/^(.+)\/annotations\/([^/]+)$/);
  if (annotationReply) {
    return handleAnnotationReply(c, annotationReply[1], annotationReply[2]);
  }
  const body = await c.req.json<{
    body?: string;
    version?: number;
    anchor?: { start?: number; end?: number; text?: string };
    parentId?: string;
  }>();
  const author = await getUserEmail(c);
  try {
    const comment = await comments.createComment({
      nestId,
      nodeId,
      author,
      body: body.body ?? "",
      version: body.version,
      anchor: body.anchor,
      parentId: body.parentId,
    });
    return c.json({ comment }, 201);
  } catch (err) {
    // Empty body / dangling parent are user errors, not 500s.
    throw new ValidationError(
      err instanceof Error ? err.message : String(err),
    );
  }
});

// POST /nests/:nestId/nodes/:nodeId/comments/:commentId/resolve
governanceNodeRoutes.post(
  "/:nodeId{.+}/comments/:commentId/resolve",
  async (c) => {
    const nestId = c.req.param("nestId")!;
    const nodeId = c.req.param("nodeId")!;
    const commentId = c.req.param("commentId")!;
    const resolvedBy = await getUserEmail(c);
    try {
      const comment = await comments.resolveComment({
        nestId,
        nodeId,
        commentId,
        resolvedBy,
      });
      return c.json({ comment });
    } catch (err: any) {
      // Only the known user-errors map to 4xx; anything else (SQLite locked,
      // I/O) must surface as a 500 via the global handler, not be masked as 404.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "Comment not found") return c.json({ error: msg }, 404);
      if (msg === "Comment is already resolved")
        return c.json({ error: msg }, 409);
      throw err;
    }
  },
);

// GET /nests/:nestId/nodes/:nodeId/activity
// Per-node activity log — who did what (comments + edits + reviews).
governanceNodeRoutes.get("/:nodeId{.+}/activity", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const limit = parseLimit(c.req.query("limit"));
  const activity = await comments.getActivity({ nestId, nodeId, limit });
  return c.json({ activity });
});

// POST /nests/:nestId/nodes/:nodeId/submit-review
governanceNodeRoutes.post("/:nodeId{.+}/submit-review", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const body = await c.req.json<{ note?: string; priority?: string }>();

  const currentVersion = await versions.getCurrentVersion(nestId, nodeId);
  if (currentVersion === 0) {
    throw new ValidationError("Node has no versions to review");
  }

  const userEmail = await getUserEmail(c);

  let request;
  try {
    request = await reviews.submitForReview({
      nestId,
      nodeId,
      version: currentVersion,
      requestedBy: userEmail,
      note: body.note,
      priority: body.priority as any,
      baseUrl: requestBaseUrl(c.req.url),
    });
  } catch (err) {
    // The service throws a plain Error for duplicate submissions —
    // translate the known message into a 409 so the client can react
    // without surfacing a generic 500 to the user.
    const msg = err instanceof Error ? err.message : String(err);
    if (/already pending/i.test(msg)) {
      throw new ConflictError(msg);
    }
    throw err;
  }

  const resolved = await stewardship.resolveStewardsForNode(nestId, nodeId);

  return c.json(
    {
      review: request,
      stewards: resolved.map((r) => ({
        email: r.steward.userEmail,
        role: r.steward.role,
        source: r.source,
      })),
    },
    201,
  );
});

// POST /nests/:nestId/nodes/:nodeId/request-deletion
// Read-tier: anyone who can see the node may flag it (that's the point — the
// people who spot stale content are usually below delete permission).
governanceNodeRoutes.post("/:nodeId{.+}/request-deletion", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as any);
  const reason = body.reason?.trim();
  if (!reason) {
    throw new ValidationError("A reason for the deletion request is required");
  }

  const userEmail = await getUserEmail(c);
  if (!(await canReadNode(nestId, nodeId, c.get("userId"), userEmail))) {
    // Same message for "gone" and "no access" — no existence oracle.
    return c.json({ error: `Node not found: ${nodeId}` }, 404);
  }
  // Existence check so a typo'd id can't park a row nobody can ever resolve.
  const { storage } = await engineCache.get(nestId);
  try {
    await storage.readDocument(nodeId);
  } catch {
    return c.json({ error: `Node not found: ${nodeId}` }, 404);
  }

  const request = await reviews.requestDeletion({
    nestId,
    nodeId,
    requestedBy: userEmail,
    reason,
    baseUrl: requestBaseUrl(c.req.url),
  });
  return c.json({ request }, 201);
});

// External-edit approve/reject MUST be registered before the generic
// /:nodeId{.+}/approve and /reject review routes below: the greedy `{.+}`
// nodeId otherwise swallows `.../external-edits/:suggestionId` and matches the
// review route first (returning "No pending review for this node"). Hono runs
// the first-registered matching handler, so specific-before-generic wins.

// POST /nests/:nestId/nodes/:nodeId/external-edits/:suggestionId/approve
governanceNodeRoutes.post(
  "/:nodeId{.+}/external-edits/:suggestionId/approve",
  async (c) => {
    const nestId = c.req.param("nestId")!;
    const nodeId = c.req.param("nodeId")!;
    const suggestionId = c.req.param("suggestionId")!;
    const body = await c.req
      .json<{ comment?: string }>()
      .catch(() => ({}) as { comment?: string });
    const actor = await getUserEmail(c);
    try {
      const result = await externalEdits.approveExternalEdit({
        nestId,
        documentId: nodeId,
        suggestionId,
        actor,
        comment: body.comment,
      });
      return c.json({
        approved: true,
        version: result.versionEntry.version,
        chainEvent: result.chainEvent.event_id,
      });
    } catch (err: any) {
      console.error(
        `[external-edit-route] approve failed nest=${nestId} node=${nodeId} suggestion=${suggestionId}`,
        { message: err?.message, name: err?.name, stack: err?.stack },
      );
      return c.json(
        { error: err.message, name: err?.name },
        400,
      );
    }
  },
);

// POST /nests/:nestId/nodes/:nodeId/external-edits/:suggestionId/reject
governanceNodeRoutes.post(
  "/:nodeId{.+}/external-edits/:suggestionId/reject",
  async (c) => {
    const nestId = c.req.param("nestId")!;
    const nodeId = c.req.param("nodeId")!;
    const suggestionId = c.req.param("suggestionId")!;
    const body = await c.req
      .json<{ reason?: string }>()
      .catch(() => ({}) as { reason?: string });
    if (!body.reason) {
      throw new ValidationError("Rejection reason is required");
    }
    const actor = await getUserEmail(c);
    try {
      const result = await externalEdits.rejectExternalEdit({
        nestId,
        documentId: nodeId,
        suggestionId,
        actor,
        reason: body.reason,
      });
      return c.json({
        rejected: true,
        chainEvent: result.chainEvent.event_id,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  },
);

// POST /nests/:nestId/nodes/:nodeId/approve
governanceNodeRoutes.post("/:nodeId{.+}/approve", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const body = await c.req.json<{ note?: string; override?: boolean }>();

  const userEmail = await getUserEmail(c);
  const isAdmin = isSuperAdmin(userEmail);

  try {
    const request = await reviews.approve({
      nestId,
      nodeId,
      approvedBy: userEmail,
      note: body.note,
      override: body.override && isAdmin,
      baseUrl: requestBaseUrl(c.req.url),
    });
    return c.json({ review: request });
  } catch (err: any) {
    return c.json({ error: err.message }, 403);
  }
});

// POST /nests/:nestId/nodes/:nodeId/reject
governanceNodeRoutes.post("/:nodeId{.+}/reject", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const body = await c.req.json<{ note?: string }>();

  if (!body.note) {
    throw new ValidationError("Rejection note is required");
  }

  const userEmail = await getUserEmail(c);

  try {
    const request = await reviews.reject({
      nestId,
      nodeId,
      rejectedBy: userEmail,
      note: body.note,
      baseUrl: requestBaseUrl(c.req.url),
    });
    return c.json({ review: request });
  } catch (err: any) {
    return c.json({ error: err.message }, 403);
  }
});

// GET /nests/:nestId/nodes/:nodeId/can-access
governanceNodeRoutes.get("/:nodeId{.+}/can-access", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const userEmail = await getUserEmail(c);
  return c.json(await stewardship.canUserAccess(nestId, nodeId, userEmail));
});

// GET /nests/:nestId/nodes/:nodeId/can-approve
governanceNodeRoutes.get("/:nodeId{.+}/can-approve", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const userEmail = await getUserEmail(c);
  return c.json(await stewardship.canUserApprove(nestId, nodeId, userEmail));
});

// GET /nests/:nestId/nodes/:nodeId/can-edit
governanceNodeRoutes.get("/:nodeId{.+}/can-edit", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const userEmail = await getUserEmail(c);
  return c.json(await stewardship.canUserEdit(nestId, nodeId, userEmail));
});

// GET /nests/:nestId/nodes/:nodeId/external-edits
governanceNodeRoutes.get("/:nodeId{.+}/external-edits", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const pending = await externalEdits.getPendingChange(nestId, nodeId);
  return c.json({ pending });
});

// GET /nests/:nestId/nodes/:nodeId/external-edits/:suggestionId
governanceNodeRoutes.get(
  "/:nodeId{.+}/external-edits/:suggestionId",
  async (c) => {
    const nestId = c.req.param("nestId")!;
    const nodeId = c.req.param("nodeId")!;
    const suggestionId = c.req.param("suggestionId")!;
    const detail = await externalEdits.getExternalEditDetail(
      nestId,
      nodeId,
      suggestionId,
    );
    if (!detail) {
      return c.json({ error: "Suggestion not found" }, 404);
    }
    return c.json({ entry: detail });
  },
);

// POST /nests/:nestId/nodes/:nodeId/cancel-review
governanceNodeRoutes.post("/:nodeId{.+}/cancel-review", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const userEmail = await getUserEmail(c);
  const request = await reviews.cancelReview({
    nestId,
    nodeId,
    cancelledBy: userEmail,
  });

  return c.json({ review: request });
});

// ─── Helpers ────────────────────────────────────────────────────────────

async function getUserEmail(c: any): Promise<string> {
  const userId = c.get("userId");
  const db = getDb();
  const user = await db.get(
    "SELECT email FROM users WHERE id = ?",
    [userId],
  ) as { email: string } | undefined;
  return user?.email || "anonymous@localhost";
}
