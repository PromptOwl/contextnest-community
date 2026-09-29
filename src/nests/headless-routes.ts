import { Hono } from "hono";
import { getDb } from "../db/client.js";
import type { AuthEnv } from "../auth/middleware.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import {
  isNestHeadless,
  listHeadlessKeys,
  mintHeadlessKey,
  revokeHeadlessKey,
} from "../auth/headless.js";

/**
 * Headless publishing (CU-wdqcq0314u) — the owner's controls. Mounted under
 * /nests/:nestId; the access gate in app.ts requires the nest "admin" tier
 * (owner, admin collaborator, server admin) for every route here, and an
 * access key can never reach them (headlessReaderVerdict).
 *
 *   GET    /headless                 → { enabled, keys }
 *   PUT    /headless  { enabled }    → publish API-only / stop (pauses keys)
 *   POST   /headless/keys { label }  → mint a key; the token is returned once
 *   DELETE /headless/keys/:keyId     → revoke it for good
 */
export const headlessRoutes = new Hono<AuthEnv>();

const MAX_LABEL = 80;

headlessRoutes.get("/headless", async (c) => {
  const nestId = c.req.param("nestId")!;
  return c.json({
    enabled: await isNestHeadless(nestId),
    keys: await listHeadlessKeys(nestId),
  });
});

headlessRoutes.put("/headless", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({}) as { enabled?: unknown });
  if (typeof body.enabled !== "boolean") {
    throw new ValidationError("enabled must be a boolean");
  }
  const db = getDb();
  const nest = (await db.get("SELECT visibility FROM nests WHERE id = ?", [nestId])) as
    | { visibility: string }
    | undefined;
  if (!nest) throw new NotFoundError("Nest not found");
  // Headless means nobody browses it: an org or public nest is already
  // readable by people without a key, which is the opposite of the promise.
  if (body.enabled && nest.visibility !== "private") {
    return c.json(
      {
        error: `Only a private nest can be published API-only — this one is ${nest.visibility}. Make it private first.`,
      },
      409,
    );
  }
  await db.run("UPDATE nests SET headless = ? WHERE id = ?", [body.enabled ? 1 : 0, nestId]);
  return c.json({ enabled: body.enabled });
});

headlessRoutes.post("/headless/keys", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<{ label?: unknown }>().catch(() => ({}) as { label?: unknown });
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    throw new ValidationError("label is required — name who the key is for (e.g. the buyer)");
  }
  if (label.length > MAX_LABEL) {
    throw new ValidationError(`label must be ${MAX_LABEL} characters or fewer`);
  }
  if (!(await isNestHeadless(nestId))) {
    return c.json(
      { error: "Publish this nest API-only first — access keys only work on a headless nest." },
      409,
    );
  }
  const { key, apiKey } = await mintHeadlessKey(nestId, label, c.get("userId"));
  return c.json({ key, api_key: apiKey }, 201);
});

headlessRoutes.delete("/headless/keys/:keyId", async (c) => {
  const revoked = await revokeHeadlessKey(c.req.param("nestId")!, c.req.param("keyId")!);
  if (!revoked) throw new NotFoundError("Access key not found");
  return c.json({ revoked: true });
});
