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
    // The API key the request authenticated with, when it used a Bearer key
    // (null for cookie/session requests and open mode). Lets pending-push rows
    // and the push allowlist attribute to — and key on — the exact credential
    // that wrote, so an agent write from one key can be whitelisted without
    // whitelisting every other key the same user holds.
    apiKeyId: string | null;
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
      // Cookie sessions carry no API key — a pending row raised by the browser
      // is attributed to the user, not a key (key_id null = all their keys).
      c.set("apiKeyId", null);
      c.set("apiKeyLabel", null);
      return next();
    }
  }

  // 2. Bearer API key
  const key = parseBearerToken(c.req.header("Authorization"));
  if (key) {
    const keyHash = hashApiKey(key);
    const record = await db.get(
      "SELECT id, label, user_id, nest_id FROM api_keys WHERE key_hash = ?",
      [keyHash],
    ) as
      | { id: string; label: string | null; user_id: string; nest_id: string | null }
      | undefined;

    if (record) {
      await db.run(
        `UPDATE api_keys SET last_used_at = ${nowExpr(db)} WHERE key_hash = ?`,
        [keyHash],
      );
      c.set("userId", record.user_id);
      c.set("nestScope", record.nest_id);
      // Attribute the request to the exact key it came in on, so pending-push
      // rows record who pushed and the allowlist can key on the credential.
      c.set("apiKeyId", record.id);
      c.set("apiKeyLabel", record.label ?? null);
      return next();
    }
  }

  // Distinguish WHY, so a client can tell "your session expired, sign back
  // in" from "this API key was revoked" instead of one opaque 401 for both.
  if (sessionId) {
    return c.json(
      { error: "Your session has expired — sign in again.", code: "session_expired" },
      401,
    );
  }
  if (key) {
    return c.json(
      { error: "This API key is invalid or has been revoked — generate a new one.", code: "invalid_key" },
      401,
    );
  }
  return c.json(
    { error: "Authentication required — sign in or provide an API key.", code: "missing_credentials" },
    401,
  );
});
