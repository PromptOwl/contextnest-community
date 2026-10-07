/**
 * Access requests over REST (CU-wdqcq041jn) — mounted at /nests/:nestId.
 *
 *   POST /access-requests                 ask (201 new, 200 the pending one)
 *   GET  /access-requests?status=         approvers: the nest's queue;
 *                                         anyone else: their own requests
 *   GET  /access-requests/mine?target_type=&target_id=
 *                                         the caller's latest for one target
 *   POST /access-requests/:id/approve     owner / nest admin / server admin
 *   POST /access-requests/:id/deny        same, with an optional note
 *
 * The nest middleware admits all of these at read tier (and lets a document
 * or folder grantee reach the first and third), because asking is exactly
 * what someone below write does. Deciding is gated here, by
 * canDecideAccessRequests. See access-request-service.ts for the rules.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { ValidationError } from "../shared/errors.js";
import { resolveCallerEmail } from "./access-guard.js";
import {
  accessTargetTitle,
  canDecideAccessRequests,
  createAccessRequest,
  decideAccessRequest,
  latestAccessRequest,
  listAccessRequests,
  normalizeAccessTarget,
  type AccessRequestStatus,
} from "./access-request-service.js";

export const accessRequestRoutes = new Hono<AuthEnv>();

accessRequestRoutes.post("/access-requests", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const body = await c.req
    .json<{ target_type?: unknown; target_id?: unknown; level?: unknown; note?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);
  const { request, created } = await createAccessRequest({
    nestId,
    requesterId: userId,
    requesterEmail: await resolveCallerEmail(userId),
    targetType: body.target_type,
    targetId: body.target_id,
    level: body.level,
    note: body.note,
    baseUrl: requestBaseUrl(c.req.url),
  });
  const title = await accessTargetTitle(nestId, {
    type: request.target_type,
    id: request.target_id,
  });
  return c.json({ request: { ...request, title }, created }, created ? 201 : 200);
});

accessRequestRoutes.get("/access-requests/mine", async (c) => {
  const nestId = c.req.param("nestId")!;
  const target = normalizeAccessTarget(
    nestId,
    c.req.query("target_type"),
    c.req.query("target_id"),
  );
  const request = await latestAccessRequest(nestId, c.get("userId"), target);
  return c.json({ request });
});

accessRequestRoutes.get("/access-requests", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const raw = c.req.query("status") || "pending";
  if (!["pending", "approved", "denied", "all"].includes(raw)) {
    throw new ValidationError('status must be "pending", "approved", "denied" or "all"');
  }
  const decider = await canDecideAccessRequests(nestId, userId);
  const requests = await listAccessRequests({
    nestId,
    status: raw as AccessRequestStatus | "all",
    // Someone who can't decide sees only what they asked for — the queue
    // names who wants what, which is the approvers' business.
    ...(decider ? {} : { requesterId: userId }),
  });
  return c.json({ requests, can_decide: decider });
});

for (const decision of ["approve", "deny"] as const) {
  accessRequestRoutes.post(`/access-requests/:requestId/${decision}`, async (c) => {
    const nestId = c.req.param("nestId")!;
    const userId = c.get("userId");
    if (!(await canDecideAccessRequests(nestId, userId))) {
      return c.json(
        { error: "Only the nest owner, a nest admin, or the server admin can decide access requests." },
        403,
      );
    }
    const body = await c.req.json<{ note?: unknown }>().catch(() => ({}) as { note?: unknown });
    const decided = await decideAccessRequest({
      nestId,
      id: c.req.param("requestId")!,
      decision,
      decidedById: userId,
      decidedByEmail: await resolveCallerEmail(userId),
      note: typeof body.note === "string" ? body.note : undefined,
      baseUrl: requestBaseUrl(c.req.url),
    });
    if (!decided) {
      return c.json({ error: "No pending access request with that id in this nest." }, 404);
    }
    return c.json({ request: decided });
  });
}
