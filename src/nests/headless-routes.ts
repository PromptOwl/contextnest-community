import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { NotFoundError } from "../shared/errors.js";
import {
  createHeadlessKey,
  headlessSharedWith,
  isNestHeadless,
  listHeadlessKeys,
  revokeHeadlessKey,
  setNestHeadless,
} from "../auth/headless.js";

/**
 * Headless publishing (CU-wdqcq0314u) — the owner's controls. Mounted under
 * /nests/:nestId; the access gate in app.ts requires the nest "admin" tier
 * (owner, admin collaborator, server admin) for every route here, and an
 * access key can never reach them (headlessReaderVerdict). The rules live in
 * auth/headless.ts, shared with the MCP twin `context_headless`.
 *
 *   GET    /headless                 → { enabled, keys }
 *   PUT    /headless  { enabled }    → publish API-only / stop (pauses keys)
 *   POST   /headless/keys { label }  → mint a key; the token is returned once
 *   DELETE /headless/keys/:keyId     → revoke it for good
 */
export const headlessRoutes = new Hono<AuthEnv>();

headlessRoutes.get("/headless", async (c) => {
  const nestId = c.req.param("nestId")!;
  return c.json({
    enabled: await isNestHeadless(nestId),
    keys: await listHeadlessKeys(nestId),
    // Headless governs people WITHOUT a seat; everyone below keeps the access
    // they have. Counted so the panel can say so before publishing.
    shared_with: await headlessSharedWith(nestId),
  });
});

headlessRoutes.put("/headless", async (c) => {
  const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({}) as { enabled?: unknown });
  const r = await setNestHeadless(c.req.param("nestId")!, body.enabled);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ enabled: r.enabled });
});

headlessRoutes.post("/headless/keys", async (c) => {
  const body = await c.req.json<{ label?: unknown }>().catch(() => ({}) as { label?: unknown });
  const r = await createHeadlessKey(c.req.param("nestId")!, body.label, c.get("userId"));
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ key: r.key, api_key: r.apiKey }, 201);
});

headlessRoutes.delete("/headless/keys/:keyId", async (c) => {
  const revoked = await revokeHeadlessKey(c.req.param("nestId")!, c.req.param("keyId")!);
  if (!revoked) throw new NotFoundError("Access key not found");
  return c.json({ revoked: true });
});
