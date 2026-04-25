import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client.js";
import { hashApiKey, parseBearerToken } from "./keys.js";

import type { NestPermission } from "../shared/access.js";

export type AuthEnv = {
  Variables: {
    userId: string;
    nestScope: string | null;
    nestPermission: NestPermission;
  };
};

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const key = parseBearerToken(c.req.header("Authorization"));
  if (!key) {
    return c.json({ error: "Missing or invalid API key" }, 401);
  }

  const keyHash = hashApiKey(key);
  const db = getDb();

  const record = db
    .prepare("SELECT user_id, nest_id FROM api_keys WHERE key_hash = ?")
    .get(keyHash) as { user_id: string; nest_id: string | null } | undefined;

  if (!record) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  // Fire-and-forget: update last_used_at
  db.prepare(
    "UPDATE api_keys SET last_used_at = datetime('now') WHERE key_hash = ?",
  ).run(keyHash);

  c.set("userId", record.user_id);
  c.set("nestScope", record.nest_id);
  await next();
});
