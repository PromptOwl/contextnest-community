/**
 * Browser-session management (cookie-based, separate from api_keys).
 *
 * A session is a random server-issued id stored in the `sessions` table
 * and round-tripped to the browser as an httpOnly cookie. JS in the
 * browser can never read the cookie value, so even a successful XSS
 * cannot exfiltrate the session.
 *
 * Sessions exist in parallel with api_keys:
 *   - `sessions`: short-lived, browser-bound, one row per logged-in
 *      browser. Created by /auth/login, /auth/register, /auth/promptowl.
 *      Destroyed by /auth/logout (and on expiry).
 *   - `api_keys`: long-lived, user-bound, AT MOST ONE per user. Used by
 *      external clients (Hootie, Claude Desktop, ctx CLI, MCP). Minted
 *      via /auth/keys, shown to user once, rotated via /auth/keys/rotate.
 *
 * Cookie name is fixed; same-origin requests get the cookie automatically.
 */
import { randomBytes } from "crypto";
import type { Context } from "hono";
import { getDb } from "../db/client.js";
import { nowExpr } from "../db/sql.js";

export const SESSION_COOKIE = "cnst_session";
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_SECS = SESSION_TTL_DAYS * 24 * 60 * 60;

function newSessionId(): string {
  // 32 bytes = 256 bits of entropy. Hex-encoded so it fits cleanly in
  // a cookie value without further escaping.
  return randomBytes(32).toString("hex");
}

function expiryIso(ttlSeconds: number = SESSION_TTL_SECS): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

/**
 * Create a new session row for `userId` and return the (opaque) session
 * id. The id is what gets set as the cookie value. Server side, the row
 * is the source of truth — deleting it logs the user out everywhere
 * that cookie is used.
 */
export async function createSession(userId: string, userAgent?: string): Promise<string> {
  const db = getDb();
  const id = newSessionId();
  await db.run(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent)
     VALUES (?, ?, ?, ?)`,
    [id, userId, expiryIso(), userAgent || null],
  );

  // Any successful login is a real "claim" — an invited teammate has now
  // accessed the account, so clear is_invited. Done HERE (the one point every
  // browser sign-in routes through: password, PromptOwl device flow, PromptOwl
  // SSO ticket, OIDC) so no flow can leave a stale "Invited" badge, and a
  // later /auth/invite on this email returns 409 instead of silently
  // overwriting a working login. Use Reset password to re-issue a credential
  // for an already-active teammate.
  try {
    await db.run("UPDATE users SET is_invited = 0 WHERE id = ? AND is_invited = 1", [
      userId,
    ]);
  } catch {
    // best-effort; never block a valid login on this bookkeeping update
  }

  return id;
}

/**
 * Look up a session by id. Returns the user_id if the session exists
 * and is not expired; null otherwise. Bumps `last_seen_at` so admins
 * can see active sessions in the DB. Expired rows are deleted lazily.
 */
export async function resolveSession(id: string): Promise<string | null> {
  const db = getDb();
  const row = await db.get(
    `SELECT user_id, expires_at FROM sessions WHERE id = ?`,
    [id],
  ) as { user_id: string; expires_at: string } | undefined;

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.run("DELETE FROM sessions WHERE id = ?", [id]);
    return null;
  }

  await db.run(
    `UPDATE sessions SET last_seen_at = ${nowExpr(db)} WHERE id = ?`,
    [id],
  );

  return row.user_id;
}

export async function deleteSession(id: string): Promise<void> {
  const db = getDb();
  await db.run("DELETE FROM sessions WHERE id = ?", [id]);
}

/** Drop every session row for a user — e.g. on password change. */
export async function deleteAllSessionsForUser(userId: string): Promise<void> {
  const db = getDb();
  await db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
}

/** Parse the session id out of the `Cookie` header, if present. */
export function getSessionIdFromRequest(c: Context): string | null {
  const cookieHeader = c.req.header("Cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) {
      const v = rest.join("=").trim();
      // Cookie values should be opaque hex; reject anything that doesn't
      // look like our format so a forged or malformed cookie can't reach
      // the SQL lookup.
      return /^[0-9a-f]{64}$/.test(v) ? v : null;
    }
  }
  return null;
}

/**
 * Build a Set-Cookie value for our session cookie. `Secure` is only
 * emitted in production-style envs (HTTPS) — Chrome refuses to store
 * a Secure cookie set over plain http://localhost, which would silently
 * break dev. SameSite=Lax is friendly to top-level navigation while
 * still blocking the classic POST-from-attacker-site CSRF vector.
 */
export function buildSessionCookie(
  id: string,
  opts: { secure?: boolean; maxAgeSeconds?: number } = {},
): string {
  const maxAge = opts.maxAgeSeconds ?? SESSION_TTL_SECS;
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Set-Cookie value that immediately clears the session cookie. */
export function buildClearSessionCookie(opts: { secure?: boolean } = {}): string {
  return buildSessionCookie("", { secure: opts.secure, maxAgeSeconds: 0 });
}

/**
 * Non-httpOnly marker cookie identifying a session that was started via OIDC
 * SSO. It carries no secret — just the flag "1" — so the SPA can read it and
 * route logout through the IdP (GET /auth/oidc/logout, RP-initiated logout)
 * instead of the plain POST /auth/logout, ending the IdP session too. Path=/
 * (the SPA reads it anywhere) and lifetime tied to the session cookie so the
 * two live and die together on the SSO logout path. A password sign-in never
 * sets it, so those users keep the plain logout.
 */
export const OIDC_SESSION_MARKER_COOKIE = "cnst_sso_session";

/**
 * The caller's PromptOwl device token, parked in an httpOnly cookie.
 *
 * WHY A COOKIE AND NOT THE DATABASE. Team import needs to call PromptOwl as the
 * user, and PromptOwl hands the token over exactly once (at device approval), so
 * it has to be kept somewhere. Keeping it server-side would turn our database
 * into a store of live credentials for someone else's SaaS — one leaked backup
 * and every PromptOwl account that ever signed in here is exposed. In a cookie
 * it lives in the user's own browser, dies with the session, and a database dump
 * contains nothing.
 *
 * `Path=/teams` is the other half: the browser then attaches this token ONLY to
 * the team routes that spend it, not to every request to this server. httpOnly
 * keeps it away from JS (so an XSS can't read it out), and its lifetime matches
 * the session cookie's so the two die together.
 *
 * The token itself is scoped `user:read` + `teams:read` upstream, so even a
 * stolen one reads a profile and a team list — it can't act as the user.
 */
export const PROMPTOWL_TOKEN_COOKIE = "cnst_po_token";
export const PROMPTOWL_TOKEN_COOKIE_PATH = "/teams";

export function buildPromptowlTokenCookie(
  token: string,
  opts: { secure?: boolean; clear?: boolean } = {},
): string {
  const parts = [
    `${PROMPTOWL_TOKEN_COOKIE}=${opts.clear ? "" : encodeURIComponent(token)}`,
    "HttpOnly",
    `Path=${PROMPTOWL_TOKEN_COOKIE_PATH}`,
    "SameSite=Lax",
    `Max-Age=${opts.clear ? 0 : SESSION_TTL_SECS}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Non-httpOnly marker saying "this session signed in with PromptOwl". Carries
 * no secret — just "1" — so the SPA can read it and decide whether to offer the
 * PromptOwl Teams tab at all. It exists because the token cookie above is
 * httpOnly AND `Path=/teams`, so the UI can neither read it nor cause it to be
 * sent anywhere else. Lifetime tracks the session, and it's cleared on logout
 * with everything else.
 *
 * It is a UI hint, nothing more: the server independently requires a real token
 * cookie on the import routes, so forging this marker gets you a tab that
 * refuses to do anything.
 */
export const PROMPTOWL_MARKER_COOKIE = "cnst_po_session";

export function buildPromptowlMarkerCookie(
  opts: { secure?: boolean; clear?: boolean } = {},
): string {
  const parts = [
    `${PROMPTOWL_MARKER_COOKIE}=${opts.clear ? "" : "1"}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${opts.clear ? 0 : SESSION_TTL_SECS}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Read the PromptOwl token cookie off a request, if present. */
export function getPromptowlTokenFromRequest(c: Context): string | null {
  const header = c.req.header("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === PROMPTOWL_TOKEN_COOKIE) {
      const v = decodeURIComponent(rest.join("="));
      // PromptOwl device tokens are `po_device_<hex>`. Anything else is a
      // forged or stale cookie — treat it as absent rather than forwarding
      // junk upstream.
      return /^po_device_[A-Za-z0-9_-]+$/.test(v) ? v : null;
    }
  }
  return null;
}

export function buildOidcMarkerCookie(
  opts: { secure?: boolean; clear?: boolean } = {},
): string {
  const parts = [
    `${OIDC_SESSION_MARKER_COOKIE}=${opts.clear ? "" : "1"}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${opts.clear ? 0 : SESSION_TTL_SECS}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Best-effort detection of whether the current request is over HTTPS,
 * so cookies can flip `Secure` automatically.
 */
export function isSecureRequest(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}
