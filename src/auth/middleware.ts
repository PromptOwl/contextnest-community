import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client.js";
import { nowExpr } from "../db/sql.js";
import { hashApiKey, parseBearerToken } from "./keys.js";
import { getSessionIdFromRequest, resolveSession } from "./sessions.js";

import type { NestPermission } from "../shared/access.js";

export type AuthEnv = {
  Variables: {
    userId: string;
    nestScope: string | null;
    nestPermission: NestPermission;
    /** What the operator named the API key this call authenticated with, when
     *  it did. The one agent name this transport can report without inventing
     *  it — see `derivedClient` (spec §9.4.2). */
    apiKeyLabel?: string;
    /** Caller attribution for this request, once a route has validated it —
     *  read by the activity-trace middleware. */
    clientMetadata?: Record<string, string | number | boolean | undefined>;
  };
};

/**
 * Two transports accepted:
 *
 *   1. Browser session cookie (`cnst_session=...`). Preferred for the
 *      web UI — httpOnly so JS can never read it. Resolved via the
 *      `sessions` table; expiry is enforced server-side.
 *
 *   2. Bearer API key (`Authorization: Bearer cnst_*`). For external
 *      clients (Hootie, Claude Desktop, ctx CLI, MCP). One per user.
 *
 * Cookie wins when both are present — same-origin browser requests will
 * usually send both, and the cookie is the safer credential to trust.
 */
export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const db = getDb();

  // 1. Cookie session
  const sessionId = getSessionIdFromRequest(c);
  if (sessionId) {
    const userId = await resolveSession(sessionId);
    if (userId) {
      c.set("userId", userId);
      c.set("nestScope", null);
      return next();
    }
  }

  // 2. Bearer API key
  const key = parseBearerToken(c.req.header("Authorization"));
  if (key) {
    const keyHash = hashApiKey(key);
    const record = await db.get(
      "SELECT user_id, nest_id, label FROM api_keys WHERE key_hash = ?",
      [keyHash],
    ) as
      | { user_id: string; nest_id: string | null; label: string | null }
      | undefined;

    if (record) {
      await db.run(
        `UPDATE api_keys SET last_used_at = ${nowExpr(db)} WHERE key_hash = ?`,
        [keyHash],
      );
      c.set("userId", record.user_id);
      c.set("nestScope", record.nest_id);
      if (record.label) c.set("apiKeyLabel", record.label);
      return next();
    }
  }

  return c.json({ error: "Missing or invalid credentials" }, 401);
});
