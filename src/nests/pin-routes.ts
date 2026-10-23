/**
 * /nests/:nestId/pins — experimental document pins (CU-wdqcq02crw).
 *
 *   GET    /pins                              → { editorial, personal, can_pin_editorial }
 *   POST   /pins        { node_id, scope }    → 201 { pin, created }   (idempotent)
 *   DELETE /pins?node_id=&scope=              → { unpinned }           (idempotent)
 *   PUT    /pins/order  { node_ids }          → { editorial, personal, can_pin_editorial }
 *
 * The document id travels in the body/query rather than the path
 * (`/nodes/:nodeId/pin`) on purpose: node ids contain slashes, so a `/pin`
 * suffix under /nodes is indistinguishable from a document whose slug is
 * `pin` — and the read tier that personal pins need would then reach that
 * document's DELETE. `/pins` is its own resource segment, like /fields.
 *
 * The nest middleware (app.ts) 404s every route here while
 * EXPERIMENTAL_DOC_PINS is off, license-gates them like the governance views,
 * and admits writes at read tier; the per-scope rule is enforced HERE (via
 * src/nodes/doc-pins.ts): editorial writes need a curator, personal ones need
 * read access to the document. Any route added here inherits that read-tier
 * admission and must gate itself.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import {
  listPins,
  parseNodeId,
  parseScope,
  pinDocument,
  reorderEditorialPins,
  unpinDocument,
} from "../nodes/doc-pins.js";
import { ValidationError } from "../shared/errors.js";

export const pinRoutes = new Hono<AuthEnv>();

async function jsonObject(c: { req: { json: () => Promise<unknown> } }) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("request body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

pinRoutes.get("/", async (c) => {
  return c.json(await listPins(c.req.param("nestId")!, c.get("userId")));
});

pinRoutes.post("/", async (c) => {
  const body = await jsonObject(c);
  const result = await pinDocument({
    nestId: c.req.param("nestId")!,
    nodeId: parseNodeId(body.node_id ?? body.nodeId),
    scope: parseScope(body.scope),
    userId: c.get("userId"),
  });
  return c.json(result, 201);
});

pinRoutes.delete("/", async (c) => {
  const unpinned = await unpinDocument({
    nestId: c.req.param("nestId")!,
    nodeId: parseNodeId(c.req.query("node_id") ?? c.req.query("nodeId")),
    scope: parseScope(c.req.query("scope")),
    userId: c.get("userId"),
  });
  return c.json({ unpinned });
});

pinRoutes.put("/order", async (c) => {
  const body = await jsonObject(c);
  const nestId = c.req.param("nestId")!;
  await reorderEditorialPins({
    nestId,
    nodeIds: body.node_ids ?? body.nodeIds,
    userId: c.get("userId"),
  });
  return c.json(await listPins(nestId, c.get("userId")));
});
