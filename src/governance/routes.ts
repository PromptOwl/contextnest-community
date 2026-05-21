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
import { getDb } from "../db/client.js";
import * as stewardship from "./stewardship-service.js";
import * as reviews from "./review-service.js";
import * as versions from "./version-service.js";
import * as externalEdits from "./external-edit-service.js";
import { loadStewardsConfig } from "./stewards-parser.js";
import { isSuperAdmin } from "./access-service.js";
import { engineCache } from "../nodes/engine.js";

// ═════════════════════════════════════════════════════════════════════════
// Nest-level routes (mounted at /:nestId)
// ═════════════════════════════════════════════════════════════════════════

export const governanceRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/stewards?scope=tag&search=architect
governanceRoutes.get("/stewards", async (c) => {
  const nestId = c.req.param("nestId")!;
  const scope = c.req.query("scope") as any;
  const search = c.req.query("search");
  const stewards = stewardship.listStewards({
    nestId,
    scope: scope || undefined,
    search: search || undefined,
  });
  return c.json({ stewards });
});

// POST /nests/:nestId/stewards
// Accepts two shapes:
//   1) Multi-user: { scope, documentId?|tagName?, users: [{email, role}] }
//   2) Legacy single-user (fallback): { scope, email, role, nodePattern?, tagName? }
governanceRoutes.post("/stewards", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<any>();
  const assignedBy = getUserEmail(c);

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

// DELETE /nests/:nestId/stewards/:stewardId — soft-remove one row
governanceRoutes.delete("/stewards/:stewardId", async (c) => {
  const stewardId = c.req.param("stewardId")!;
  stewardship.removeSteward(stewardId);
  return c.json({ removed: true });
});

// POST /nests/:nestId/stewards/sync
governanceRoutes.post("/stewards/sync", async (c) => {
  const nestId = c.req.param("nestId")!;
  const stewardsConfig = loadStewardsConfig(nestId);
  if (!stewardsConfig) {
    return c.json({ synced: 0, message: "No stewards.yaml found" });
  }
  const count = stewardship.syncFromConfig(nestId, stewardsConfig);
  return c.json({ synced: count });
});

// GET /nests/:nestId/review-queue
governanceRoutes.get("/review-queue", async (c) => {
  const nestId = c.req.param("nestId")!;
  const status = c.req.query("status") || "pending";
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  const result = reviews.getReviewQueue({
    nestId,
    status: status as any,
    limit,
    offset,
  });

  return c.json(result);
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
  const actor = getUserEmail(c);
  const result = await externalEdits.scanNestForDrift(nestId, actor);
  return c.json(result);
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
    stewardship.resolveStewardsWithFallback(nestId, nodeId);
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

  const allVersions = versions.getVersions(nestId, nodeId);
  const approved = versions.getApprovedVersion(nestId, nodeId);

  return c.json({
    versions: allVersions,
    approvedVersion: approved,
    currentVersion: allVersions[0]?.version || 0,
  });
});

// GET /nests/:nestId/nodes/:nodeId/reviews
governanceNodeRoutes.get("/:nodeId{.+}/reviews", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const history = reviews.getReviewHistory(nestId, nodeId);
  return c.json({ reviews: history });
});

// POST /nests/:nestId/nodes/:nodeId/submit-review
governanceNodeRoutes.post("/:nodeId{.+}/submit-review", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const body = await c.req.json<{ note?: string; priority?: string }>();

  const currentVersion = versions.getCurrentVersion(nestId, nodeId);
  if (currentVersion === 0) {
    throw new ValidationError("Node has no versions to review");
  }

  const userEmail = getUserEmail(c);

  let request;
  try {
    request = reviews.submitForReview({
      nestId,
      nodeId,
      version: currentVersion,
      requestedBy: userEmail,
      note: body.note,
      priority: body.priority as any,
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

  const resolved = stewardship.resolveStewardsForNode(nestId, nodeId);

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

  const userEmail = getUserEmail(c);
  const isAdmin = isSuperAdmin(userEmail);

  try {
    const request = await reviews.approve({
      nestId,
      nodeId,
      version: versions.getCurrentVersion(nestId, nodeId),
      approvedBy: userEmail,
      note: body.note,
      override: body.override && isAdmin,
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

  const userEmail = getUserEmail(c);

  try {
    const request = reviews.reject({
      nestId,
      nodeId,
      version: versions.getCurrentVersion(nestId, nodeId),
      rejectedBy: userEmail,
      note: body.note,
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
  const userEmail = getUserEmail(c);
  return c.json(stewardship.canUserAccess(nestId, nodeId, userEmail));
});

// GET /nests/:nestId/nodes/:nodeId/can-approve
governanceNodeRoutes.get("/:nodeId{.+}/can-approve", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const userEmail = getUserEmail(c);
  return c.json(stewardship.canUserApprove(nestId, nodeId, userEmail));
});

// GET /nests/:nestId/nodes/:nodeId/can-edit
governanceNodeRoutes.get("/:nodeId{.+}/can-edit", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const userEmail = getUserEmail(c);
  return c.json(stewardship.canUserEdit(nestId, nodeId, userEmail));
});

// GET /nests/:nestId/nodes/:nodeId/external-edits
governanceNodeRoutes.get("/:nodeId{.+?}/external-edits", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const pending = await externalEdits.getPendingChange(nestId, nodeId);
  return c.json({ pending });
});

// GET /nests/:nestId/nodes/:nodeId/external-edits/:suggestionId
governanceNodeRoutes.get(
  "/:nodeId{.+?}/external-edits/:suggestionId",
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
  "/:nodeId{.+?}/external-edits/:suggestionId/approve",
  async (c) => {
    const nestId = c.req.param("nestId")!;
    const nodeId = c.req.param("nodeId")!;
    const suggestionId = c.req.param("suggestionId")!;
    const body = await c.req
      .json<{ comment?: string }>()
      .catch(() => ({}) as { comment?: string });
    const actor = getUserEmail(c);
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
  "/:nodeId{.+?}/external-edits/:suggestionId/reject",
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
    const actor = getUserEmail(c);
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

  const userEmail = getUserEmail(c);
  const request = reviews.cancelReview({
    nestId,
    nodeId,
    cancelledBy: userEmail,
  });

  return c.json({ review: request });
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
