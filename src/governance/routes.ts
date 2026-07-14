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
import { resolveCallerEmail } from "./access-guard.js";
import * as comments from "./comment-service.js";
import * as versions from "./version-service.js";
import * as externalEdits from "./external-edit-service.js";
import { loadStewardsConfig } from "./stewards-parser.js";
import { isSuperAdmin } from "./access-service.js";
import { engineCache } from "../nodes/engine.js";
import { bodyOnly } from "../nodes/service.js";
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
  const offsetRaw = parseInt(c.req.query("offset") ?? "", 10);
  const offset = Number.isNaN(offsetRaw) || offsetRaw < 0 ? 0 : offsetRaw;
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);

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

  const allVersions = await versions.getVersions(nestId, nodeId);
  const approved = await versions.getApprovedVersion(nestId, nodeId);

  // getVersions returns content:"" (bodies live on disk, not the table).
  // Reconstruct each version's body so the history panel can preview it
  // before restoring. Failures just leave content empty for that row.
  const { versions: versionManager } = await engineCache.get(nestId);
  const withContent = await Promise.all(
    allVersions.map(async (v) => {
      try {
        const raw = await versionManager.reconstructVersion(nodeId, v.version);
        return { ...v, content: bodyOnly(nodeId, raw) };
      } catch {
        return v;
      }
    }),
  );

  return c.json({
    versions: withContent,
    approvedVersion: approved,
    currentVersion: allVersions[0]?.version || 0,
  });
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
      version: await versions.getCurrentVersion(nestId, nodeId),
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
      version: await versions.getCurrentVersion(nestId, nodeId),
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
