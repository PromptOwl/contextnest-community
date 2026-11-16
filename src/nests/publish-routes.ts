/**
 * Publish management API — create / list / inspect-views / revoke a public
 * link for a single document. Mounted at `/nests/:nestId/publications`
 * (POST `/nests/:nestId/publish` is already the nest-snapshot endpoint).
 *
 * Managing publishes is an owner/admin act (same authority as the steward
 * roster, via canManageStewards) — publishing exposes governed content on the
 * open web, so it is never available to a plain collaborator. The public
 * render/gate surface lives separately in publish-render-routes.ts under `/p`.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { ForbiddenError, NotFoundError } from "../shared/errors.js";
import { canManageStewards } from "../governance/stewardship-service.js";
import { requestBaseUrl } from "../shared/base-url.js";
import {
  publishDocumentLink,
  listPublish,
  getPublishById,
  revokePublish,
  listViews,
  toPublishResponse,
  PUBLISH_FORBIDDEN,
  PUBLISH_NOT_FOUND,
  type PublishRequest,
} from "./publish-service.js";

export const publishRoutes = new Hono<AuthEnv>();

async function requireManage(c: any, nestId: string): Promise<void> {
  if (!(await canManageStewards(nestId, c.get("userId")))) {
    throw new ForbiddenError(PUBLISH_FORBIDDEN);
  }
}

// POST /nests/:nestId/publish — publish a document at a public/gated link.
publishRoutes.post("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireManage(c, nestId);
  const { row, link } = await publishDocumentLink({
    nestId,
    userId: c.get("userId"),
    baseUrl: requestBaseUrl(c.req.url),
    request: await c.req.json<PublishRequest>(),
  });
  return c.json({ publish: toPublishResponse(row), link }, 201);
});

// GET /nests/:nestId/publish — the publishes for this nest, with their links.
publishRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireManage(c, nestId);
  const base = requestBaseUrl(c.req.url);
  const rows = await listPublish(nestId);
  return c.json({
    count: rows.length,
    publishes: rows.map((r) => ({ ...toPublishResponse(r), link: `${base}/p/${r.slug}` })),
  });
});

// GET /nests/:nestId/publish/:id/views — who opened it, when.
publishRoutes.get("/:id/views", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireManage(c, nestId);
  const row = await getPublishById(nestId, c.req.param("id")!);
  if (!row) throw new NotFoundError(PUBLISH_NOT_FOUND);
  const views = await listViews(row.id);
  return c.json({ count: views.length, views });
});

// DELETE /nests/:nestId/publish/:id — revoke the link.
publishRoutes.delete("/:id", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireManage(c, nestId);
  const ok = await revokePublish(nestId, c.req.param("id")!);
  if (!ok) throw new NotFoundError(PUBLISH_NOT_FOUND);
  return c.json({ revoked: true });
});
