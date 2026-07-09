import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { nowExpr } from "../db/sql.js";
import {
  generateApiKey,
  hashApiKey,
  getKeyPrefix,
  hashPassword,
  verifyPassword,
  parseBearerToken,
} from "./keys.js";
import { authMiddleware, type AuthEnv } from "./middleware.js";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSession,
  deleteAllSessionsForUser,
  deleteSession,
  getSessionIdFromRequest,
  isSecureRequest,
  resolveSession,
} from "./sessions.js";
import { ValidationError } from "../shared/errors.js";
import { normalizeEmail } from "../shared/email.js";
import { config } from "../config.js";
import { trackEvent } from "../telemetry/tracker.js";
import {
  getCurrentLicense,
  isLicenseAdminEmail,
  isLicenseAdminUserId,
} from "./license.js";
import { tryConsume, isLimited, recordFailure, clear } from "../shared/rate-limit.js";
import { verifySsoTicket } from "./sso-token.js";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ANON_USER_ID } from "../shared/constants.js";

// Auth-endpoint rate limits. Keyed on IP for anonymous attempts + email
// on login (so brute-forcing one email from a botnet still clamps).
const LOGIN_LIMIT = { max: 5, windowMs: 15 * 60_000 };       // 5 / 15 min
const REGISTER_LIMIT = { max: 3, windowMs: 60 * 60_000 };    // 3 / hr
const DEVICE_LIMIT = { max: 10, windowMs: 15 * 60_000 };     // 10 / 15 min

// Warn once (not per request) when SSO runs without audience binding.
let warnedMissingSsoAudience = false;

const MIN_PASSWORD_LENGTH = 8;

// Single source of truth for password rules so register / change / admin-reset
// stay consistent. Rejects whitespace-only secrets (e.g. 8 spaces) which would
// otherwise satisfy a naive `length` check while being effectively empty.
function assertValidPassword(password: string, label = "password"): void {
  if (password.trim().length === 0) {
    throw new ValidationError(`${label} cannot be empty or only whitespace`);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      `${label} must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
}

function clientIp(c: any): string {
  // Respect reverse-proxy headers; fall back to the raw socket address if
  // none. Intentionally trusts the first forwarded IP — deploy behind a
  // proxy you control.
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp.trim();
  // No proxy (e.g. running locally) — read the TCP peer address directly.
  try {
    const addr = getConnInfo(c).remote.address;
    if (addr) return addr;
  } catch {
    // Runtime without conninfo support — fall through to "unknown".
  }
  return "unknown";
}

/**
 * Resolve the caller's userId from either an httpOnly session cookie
 * (preferred, used by the web UI) or a Bearer API key (used by external
 * clients). Returns null if neither is present or valid. Used by
 * endpoints that need optional auth (e.g. /admin-status) and by manual
 * admin checks below that pre-date the middleware factor-out.
 */
async function resolveCallerUserId(c: any): Promise<string | null> {
  const sessionId = getSessionIdFromRequest(c);
  if (sessionId) {
    const uid = await resolveSession(sessionId);
    if (uid) return uid;
  }
  const key = parseBearerToken(c.req.header("Authorization"));
  if (key) {
    const db = getDb();
    const row = await db.get(
      "SELECT user_id FROM api_keys WHERE key_hash = ?",
      [hashApiKey(key)],
    ) as { user_id: string } | undefined;
    if (row) return row.user_id;
  }
  return null;
}

// Enforce PROMPTOWL_SIGN_IN_GATE at the device-auth entry points. The
// device flow is anonymous until the final /auth/promptowl token exchange,
// so identity-based blocking is only partial here:
//   - open       → no-op.
//   - disabled   → always blocked (no PromptOwl sign-in for anyone).
//   - admin-only → block an authenticated non-admin up front; an anonymous
//     caller is allowed through and the owner-email check at /auth/promptowl
//     is the real gate (the caller's email isn't known until then).
async function deviceGateBlocked(c: any): Promise<{ error: string; gate: string } | null> {
  const gate = config.PROMPTOWL_SIGN_IN_GATE;
  if (gate === "open") return null;
  const error =
    "PromptOwl sign-in is restricted on this server. Use email and password, or contact your admin.";
  if (gate === "disabled") return { error, gate };
  // admin-only
  const callerId = await resolveCallerUserId(c);
  if (callerId && !(await isLicenseAdminUserId(callerId))) return { error, gate };
  return null;
}

function setSessionCookie(c: any, sessionId: string) {
  c.header(
    "Set-Cookie",
    buildSessionCookie(sessionId, { secure: isSecureRequest(c) }),
  );
}

function clearSessionCookie(c: any) {
  c.header(
    "Set-Cookie",
    buildClearSessionCookie({ secure: isSecureRequest(c) }),
  );
}

type ClaimBlocked =
  | { reason: "license_required" }
  | { reason: "email_mismatch"; license_owner_email: string | null };

type ProvisionResult =
  | { ok: false; status: 403; error: string; gate: string }
  | {
    ok: true;
    user: { id: string; email: string; name: string | null };
    isAdmin: boolean;
    claimBlocked: ClaimBlocked | null;
  };

/**
 * Provision (or look up) a user from a PromptOwl identity and start a browser
 * session for them. Shared by BOTH PromptOwl sign-in paths:
 *   - POST /auth/promptowl — manual device-code flow (any self-hosted server)
 *   - GET  /auth/sso       — one-click SSO ticket (official server only)
 *
 * Enforces PROMPTOWL_SIGN_IN_GATE, auto-provisions an unknown email, derives
 * admin status live from the installed license, and (on success) sets the
 * httpOnly session cookie. The caller owns the response shape — JSON for the
 * device flow, a redirect for SSO.
 */
async function provisionPromptowlUser(
  c: any,
  rawEmail: string,
  rawName: string | null | undefined,
): Promise<ProvisionResult> {
  // PROMPTOWL_SIGN_IN_GATE — optionally restrict PromptOwl sign-in. When not
  // "open", only the license owner (admin) may complete it; everyone else
  // uses email/password. Enforced HERE (the identity point) so a non-admin
  // can't even auto-provision a user via PromptOwl.
  const gate = config.PROMPTOWL_SIGN_IN_GATE;
  if (gate !== "open") {
    if (gate === "disabled" || !isLicenseAdminEmail(rawEmail)) {
      return {
        ok: false,
        status: 403,
        error:
          "PromptOwl sign-in is restricted on this server. Use email and password, or contact your admin.",
        gate,
      };
    }
  }

  const db = getDb();
  const meEmail = normalizeEmail(rawEmail);

  let user = await db.get(
    "SELECT id, email, name FROM users WHERE LOWER(email) = ?",
    [meEmail],
  ) as
    | { id: string; email: string; name: string | null }
    | undefined;

  if (!user) {
    const userId = uuid();
    const placeholderHash = await hashPassword(uuid());
    await db.run(
      "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
      [userId, meEmail, rawName || null, placeholderHash],
    );
    user = { id: userId, email: meEmail, name: rawName || null };

    trackEvent("user.register", {
      userId,
      email: rawEmail,
      method: "promptowl",
    });
  } else {
    trackEvent("user.login", { userId: user.id, method: "promptowl" });
  }

  // ─── Admin derivation ───
  // Admin is whoever owns the currently-installed license, not a sticky DB
  // flag. Transferring the license to a new PromptOwl account immediately
  // demotes the old admin and promotes the new owner — no manual cleanup.
  let claimBlocked: ClaimBlocked | null = null;
  const lic = getCurrentLicense();
  let isAdmin = false;
  if (!lic?.valid) {
    claimBlocked = { reason: "license_required" };
  } else if (
    lic.ownerEmail &&
    lic.ownerEmail.toLowerCase() === rawEmail.toLowerCase()
  ) {
    isAdmin = true;
    trackEvent("admin.claim", { userId: user.id, email: user.email });
  } else {
    claimBlocked = {
      reason: "email_mismatch",
      license_owner_email: lic.ownerEmail,
    };
  }

  const sessionId = await createSession(user.id, c.req.header("User-Agent"));
  setSessionCookie(c, sessionId);

  return { ok: true, user, isAdmin, claimBlocked };
}

export const authRoutes = new Hono<AuthEnv>();

// POST /auth/register
//
// SELF sign-up only — creates a brand-new account. It deliberately does NOT set
// the password on an already-provisioned (invited) account: there's no email
// verification here, so letting anyone who knows an invited address choose its
// password would be account takeover. Invited users instead receive a password
// from their admin (POST /auth/invite / admin reset), log in, then change it.
authRoutes.post("/register", async (c) => {
  // Manual sign-in gate. Self-registration is allowed ONLY in "open" mode.
  // "invite-only" and "disabled" both refuse it — invited users receive a
  // password from their admin (Invite / Reset) and log in with that instead.
  if (config.MANUAL_SIGN_IN !== "open") {
    return c.json(
      {
        error:
          "Self-registration is disabled on this server. If you were invited, use “Set your password” to activate your account. Otherwise ask your admin for an invite.",
      },
      403,
    );
  }

  const body = await c.req.json<{
    email?: string;
    password?: string;
    name?: string;
  }>();

  if (!body.email || !body.password) {
    throw new ValidationError("email and password are required");
  }
  assertValidPassword(body.password);
  const email = normalizeEmail(body.email);

  const ip = clientIp(c);
  if (!tryConsume(`register:ip:${ip}`, REGISTER_LIMIT)) {
    return c.json({ error: "Too many registration attempts, try again later" }, 429);
  }

  const db = getDb();
  const existing = await db.get(
    "SELECT id, is_invited FROM users WHERE LOWER(email) = ?",
    [email],
  ) as { id: string; is_invited: number } | undefined;

  if (existing) {
    // An admin-provisioned placeholder can't be self-registered — that would
    // let anyone who knows the address take over the account. The admin shares
    // a password for it (Invite / Reset password); the user logs in + changes it.
    if (existing.is_invited === 1) {
      return c.json(
        {
          error:
            "You've been invited to this server. Ask your admin for your temporary password, then sign in and change it — you can't set it here.",
        },
        409,
      );
    }
    throw new ValidationError("Email already registered");
  }

  const userId = uuid();
  const passwordHash = await hashPassword(body.password);
  await db.run(
    "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
    [userId, email, body.name || null, passwordHash],
  );
  trackEvent("user.register", { userId, email });

  // Web session — browser auth lives in an httpOnly cookie. We do NOT
  // mint an external api_key here. The user can mint one on demand from
  // the Connect modal via /auth/keys.
  const sessionId = await createSession(userId, c.req.header("User-Agent"));
  setSessionCookie(c, sessionId);

  return c.json(
    {
      user: {
        id: userId,
        email,
        name: body.name || null,
        is_admin: isLicenseAdminEmail(email),
      },
    },
    201,
  );
});

// POST /auth/login
authRoutes.post("/login", async (c) => {
  // Manual sign-in gate — only "disabled" blocks login. "invite-only" still
  // permits existing + invited users to log in (it only restricts NEW
  // self-registration, enforced in /auth/register). The /admin/settings
  // validator prevents disabling both manual and PromptOwl at once.
  if (config.MANUAL_SIGN_IN === "disabled") {
    return c.json(
      {
        error:
          "Email & password sign-in is disabled on this server. Sign in with PromptOwl, or contact your admin.",
      },
      403,
    );
  }

  const body = await c.req.json<{
    email?: string;
    password?: string;
  }>();

  if (!body.email || !body.password) {
    throw new ValidationError("email and password are required");
  }

  // Clamp both by IP and by email — botnet can't parallelize against one
  // account, and a single IP can't brute-force many accounts. Only FAILED
  // logins count toward the limit (recorded below), so frequent successful
  // login/logout cycles never trip the brute-force guard.
  //
  // When the IP is unidentifiable (no proxy headers → "unknown"), every
  // caller collapses to the same key. Clamping on it would let one user's
  // failures lock out everyone else, so skip the IP clamp in that case and
  // rely on the per-email key. Deploy behind a proxy that sets
  // x-forwarded-for to get real per-IP protection.
  const ip = clientIp(c);
  // Normalize like every other path (register/invite/sso) — trim + lowercase.
  // Login previously only lowercased, so a leading/trailing space from mobile
  // autofill missed the LOWER(email) lookup → spurious "invalid credentials".
  const emailLower = normalizeEmail(body.email);
  const hasIp = ip !== "unknown";
  const ipKey = `login:ip:${ip}`;
  const emailKey = `login:email:${emailLower}`;
  if ((hasIp && isLimited(ipKey, LOGIN_LIMIT)) || isLimited(emailKey, LOGIN_LIMIT)) {
    return c.json({ error: "Too many login attempts, try again later" }, 429);
  }

  const db = getDb();
  const user = await db.get(
    "SELECT id, email, name, password_hash, is_admin, is_invited FROM users WHERE LOWER(email) = ?",
    [emailLower],
  ) as
    | {
      id: string;
      email: string;
      name: string | null;
      password_hash: string;
      is_admin: number;
      is_invited: number;
    }
    | undefined;

  const check = user
    ? await verifyPassword(body.password, user.password_hash)
    : { ok: false, needsRehash: false };
  if (!user || !check.ok) {
    if (hasIp) recordFailure(ipKey, LOGIN_LIMIT);
    recordFailure(emailKey, LOGIN_LIMIT);
    console.warn(`[auth] login FAIL — counter++ ip=${ip} email=${emailLower}`);
    return c.json({ error: "Invalid credentials" }, 401);
  }

  // Success — wipe accumulated failures so a legit login resets the guard.
  console.log(`[auth] login OK — counter reset ip=${ip} email=${emailLower}`);
  if (hasIp) clear(ipKey);
  clear(emailKey);

  // A first successful login is a real "claim" too — an invited teammate has
  // now accessed the account, so clear is_invited. This clears the "Invited"
  // badge and makes a later /auth/invite on this email return 409 instead of
  // silently overwriting a working login (re-invite only refreshes the temp
  // password of someone who has NOT logged in yet). Use Reset password to
  // re-issue a credential for an already-active teammate.
  if (user.is_invited === 1) {
    try {
      await db.run("UPDATE users SET is_invited = 0 WHERE id = ?", [user.id]);
    } catch {
      // best-effort; never block a valid login on this bookkeeping update
    }
  }

  // Legacy SHA-256 password? Silently upgrade to bcrypt on this successful
  // login so the DB migrates itself over time without forcing a reset.
  if (check.needsRehash) {
    try {
      const newHash = await hashPassword(body.password);
      await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [
        newHash,
        user.id,
      ]);
    } catch {
      // best-effort; never block login on the migration path
    }
  }

  trackEvent("user.login", { userId: user.id });

  const sessionId = await createSession(user.id, c.req.header("User-Agent"));
  setSessionCookie(c, sessionId);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      is_admin: isLicenseAdminEmail(user.email),
    },
  });
});

// POST /auth/logout — clear the current browser session
authRoutes.post("/logout", async (c) => {
  const sessionId = getSessionIdFromRequest(c);
  if (sessionId) await deleteSession(sessionId);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ─── External-client API key (one per user) ──────────────────────────────

// POST /auth/keys — mint the user's single external-client API key.
//
// Returns 409 if a key already exists. Use /auth/keys/rotate to replace
// an existing key. The plaintext is shown ONCE on creation and never
// retrievable again — server stores only sha256(key).
authRoutes.post("/keys", authMiddleware, async (c) => {
  const body = await c.req.json<{ label?: string; nest_id?: string }>().catch(
    () => ({}) as { label?: string; nest_id?: string },
  );
  const db = getDb();
  const userId = c.get("userId");

  const existing = await db.get(
    "SELECT key_prefix FROM api_keys WHERE user_id = ?",
    [userId],
  ) as { key_prefix: string } | undefined;

  if (existing) {
    return c.json(
      {
        error: "An API key already exists for this user. Rotate it instead.",
        key_prefix: existing.key_prefix,
      },
      409,
    );
  }

  const apiKey = generateApiKey();
  const keyId = uuid();
  await db.run(
    "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, nest_id, label) VALUES (?, ?, ?, ?, ?, ?)",
    [
      keyId,
      userId,
      hashApiKey(apiKey),
      getKeyPrefix(apiKey),
      body.nest_id || null,
      body.label || null,
    ],
  );

  return c.json(
    { api_key: apiKey, key_prefix: getKeyPrefix(apiKey) },
    201,
  );
});

// POST /auth/keys/rotate — atomically replace the caller's existing key.
//
// One row per user (DB UNIQUE), so we DELETE + INSERT inside a
// transaction to preserve that invariant. New plaintext returned once.
authRoutes.post("/keys/rotate", authMiddleware, async (c) => {
  const body = await c.req.json<{ label?: string; nest_id?: string }>().catch(
    () => ({}) as { label?: string; nest_id?: string },
  );
  const db = getDb();
  const userId = c.get("userId");

  const apiKey = generateApiKey();
  const keyId = uuid();

  const prior = await db.get(
    "SELECT label, nest_id FROM api_keys WHERE user_id = ?",
    [userId],
  ) as { label: string | null; nest_id: string | null } | undefined;

  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM api_keys WHERE user_id = ?", [userId]);
    await tx.run(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, nest_id, label) VALUES (?, ?, ?, ?, ?, ?)",
      [
        keyId,
        userId,
        hashApiKey(apiKey),
        getKeyPrefix(apiKey),
        body.nest_id ?? prior?.nest_id ?? null,
        body.label ?? prior?.label ?? null,
      ],
    );
  });

  return c.json({ api_key: apiKey, key_prefix: getKeyPrefix(apiKey) });
});

// GET /auth/keys — return the caller's key metadata (no plaintext).
authRoutes.get("/keys", authMiddleware, async (c) => {
  const db = getDb();
  const keys = await db.all(
    "SELECT id, key_prefix, nest_id, label, created_at, last_used_at FROM api_keys WHERE user_id = ?",
    [c.get("userId")],
  );
  return c.json({ keys });
});

// DELETE /auth/keys/:keyId — revoke the caller's external key.
authRoutes.delete("/keys/:keyId", authMiddleware, async (c) => {
  const db = getDb();
  const result = await db.run(
    "DELETE FROM api_keys WHERE id = ? AND user_id = ?",
    [c.req.param("keyId"), c.get("userId")],
  );

  if (result.changes === 0) {
    return c.json({ error: "Key not found" }, 404);
  }
  return c.json({ deleted: true });
});

// ─── PromptOwl Device Auth ──────────────────────────────────────────────

// POST /auth/device — initiate PromptOwl device auth
authRoutes.post("/device", async (c) => {
  const blocked = await deviceGateBlocked(c);
  if (blocked) return c.json(blocked, 403);
  if (!tryConsume(`device:ip:${clientIp(c)}`, DEVICE_LIMIT)) {
    return c.json({ error: "Too many device auth attempts, try again later" }, 429);
  }
  const body = await c.req.json<{
    deviceName?: string;
    deviceType?: string;
  }>();
  const promptowlUrl = config.PROMPTOWL_API_URL.replace(/\/$/, "");

  const res = await fetch(`${promptowlUrl}/api/auth/device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceName: body.deviceName || "ContextNest Community",
      deviceType: body.deviceType || "webapp",
    }),
  });

  const data = await res.json();
  if (!res.ok) return c.json(data, res.status as any);

  if (data.verificationUrl && !data.verificationUrl.startsWith("http")) {
    data.verificationUrl = `${promptowlUrl}${data.verificationUrl}`;
  }

  return c.json(data);
});

// GET /auth/device/poll — poll for device approval
authRoutes.get("/device/poll", async (c) => {
  const blocked = await deviceGateBlocked(c);
  if (blocked) return c.json(blocked, 403);
  const code = c.req.query("code");
  const clientSecret = c.req.query("client_secret");

  if (!code || !clientSecret) {
    return c.json({ error: "code and client_secret are required" }, 400);
  }

  const promptowlUrl = config.PROMPTOWL_API_URL.replace(/\/$/, "");
  const res = await fetch(
    `${promptowlUrl}/api/auth/device/poll?code=${encodeURIComponent(code)}&client_secret=${encodeURIComponent(clientSecret)}`,
  );

  const data = await res.json();
  return c.json(data, res.status as any);
});

// POST /auth/promptowl — exchange PromptOwl token for a browser session
authRoutes.post("/promptowl", async (c) => {
  if (!tryConsume(`promptowl:ip:${clientIp(c)}`, DEVICE_LIMIT)) {
    return c.json({ error: "Too many exchange attempts, try again later" }, 429);
  }
  const body = await c.req.json<{ token?: string }>();

  if (!body.token) {
    throw new ValidationError("token is required");
  }

  const promptowlUrl = config.PROMPTOWL_API_URL.replace(/\/$/, "");
  const meRes = await fetch(`${promptowlUrl}/api/user/me`, {
    headers: { Authorization: `Bearer ${body.token}` },
  });

  if (!meRes.ok) {
    return c.json({ error: "Invalid or expired PromptOwl token" }, 401);
  }

  const meData = (await meRes.json()) as {
    user?: { name?: string; email?: string };
    name?: string;
    email?: string;
  };
  const me = meData.user || meData;
  if (!me.email) {
    return c.json(
      { error: "Could not retrieve user email from PromptOwl" },
      401,
    );
  }

  const result = await provisionPromptowlUser(c, me.email, me.name);
  if (!result.ok) {
    return c.json({ error: result.error, gate: result.gate }, result.status);
  }

  return c.json({
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      is_admin: result.isAdmin,
    },
    ...(result.claimBlocked ? { claim_blocked: result.claimBlocked } : {}),
  });
});

// GET /auth/sso — one-click SSO auto-login from PromptOwl.
//
// THE DOMAIN LOCK. PromptOwl redirects a logged-in user here with a short-lived
// JWT ticket signed with the shared OFFICIAL_COMMUNITY_SSO_SECRET. Only the ONE
// official deployment holds that secret, so:
//   - secret unset  → feature disabled (every self-hosted server); bounce to the
//                     SPA with ?sso_error=not_supported so the user sees a clear
//                     message instead of a bare 404. This does NOT weaken the
//                     lock: without the secret no ticket can be verified, so
//                     other domains still cannot auto-login.
//   - secret set    → verify signature + audience + expiry + one-time jti, then
//                     provision the user and start a session, exactly like the
//                     manual /auth/promptowl flow.
// On any failure the user is bounced to the app with ?sso_error=<code> so the
// SPA can show a message and fall back to manual sign-in.
authRoutes.get("/sso", async (c) => {
  const ssoError = (code: string) => c.redirect(`/?sso_error=${code}`, 302);

  const secret = config.OFFICIAL_COMMUNITY_SSO_SECRET;
  // Self-hosted servers (no shared secret) don't support one-click SSO.
  if (!secret) return ssoError("not_supported");

  if (!tryConsume(`sso:ip:${clientIp(c)}`, DEVICE_LIMIT)) {
    return ssoError("rate_limited");
  }

  const ticket = c.req.query("ticket");
  if (!ticket) return ssoError("missing_ticket");

  let claims;
  try {
    claims = verifySsoTicket(ticket, secret);
  } catch {
    return ssoError("invalid_ticket");
  }

  // Audience binding — a ticket minted for a different server is rejected, so
  // it can't be replayed elsewhere even if the secret were shared. When
  // PUBLIC_BASE_URL is unset this binding is DISABLED (the secret is the only
  // control left), so warn loudly — that's a misconfiguration on an official
  // deployment, not an intended mode.
  const expectedAud = config.PUBLIC_BASE_URL;
  if (!expectedAud && !warnedMissingSsoAudience) {
    warnedMissingSsoAudience = true;
    console.warn(
      "[sso] OFFICIAL_COMMUNITY_SSO_SECRET is set but PUBLIC_BASE_URL is empty — " +
        "ticket audience binding is DISABLED. Set PUBLIC_BASE_URL so a ticket minted " +
        "for another server cannot be replayed against this one.",
    );
  }
  if (expectedAud) {
    const aud = (claims.aud || "").replace(/\/$/, "");
    if (aud !== expectedAud) return ssoError("bad_audience");
  }

  // Reject a malformed subject before burning the jti. Tickets are minted by
  // PromptOwl (trusted), but a whitespace/garbage sub would otherwise create a
  // degenerate user row with an empty email that can never match a grant.
  const sub = (claims.sub || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sub) || sub.length > 254) {
    return ssoError("invalid_ticket");
  }

  // One-time use — redeem the jti exactly once. Insert-or-conflict is the
  // atomic replay guard.
  if (!claims.jti) return ssoError("invalid_ticket");
  const db = getDb();
  await db.run(`DELETE FROM sso_used_jti WHERE expires_at < ${nowExpr(db)}`);
  const expiresAtIso = new Date((claims.exp ?? 0) * 1000).toISOString();
  try {
    await db.run(
      "INSERT INTO sso_used_jti (jti, expires_at) VALUES (?, ?)",
      [claims.jti, expiresAtIso],
    );
  } catch (err: any) {
    // PRIMARY KEY conflict = ticket already redeemed (replay). Any other DB
    // fault (missing table, disk full, corruption) must NOT masquerade as
    // "already used" — surface it distinctly so an outage is diagnosable.
    if (err?.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return ssoError("ticket_used");
    }
    console.error("[sso] failed to record ticket jti:", err);
    return ssoError("service_error");
  }

  // jti is already burned above. If provisioning throws (transient: bcrypt
  // fault, duplicate-email race between the SELECT and INSERT), release the jti
  // so the still-valid ticket can be retried instead of being permanently dead.
  // A deterministic !ok (gate restriction) is NOT released — retrying can't help
  // and keeping the jti burned preserves the one-time replay guard.
  let result;
  try {
    result = await provisionPromptowlUser(c, sub, claims.name);
  } catch (err) {
    await db.run("DELETE FROM sso_used_jti WHERE jti = ?", [claims.jti]);
    console.error("[sso] provisioning failed; released jti for retry:", err);
    return ssoError("service_error");
  }
  if (!result.ok) return ssoError("sign_in_restricted");

  // Success — session cookie set by the helper; land on the app home.
  return c.redirect("/", 302);
});

// GET /auth/admin-status — does this server have an admin? Who am I?
authRoutes.get("/admin-status", async (c) => {
  const db = getDb();
  // Admin = current license owner. If the owner has never logged in to
  // this server we still report the email so the UI knows who CAN
  // claim, but `name` only resolves when a matching users row exists.
  const lic = getCurrentLicense();
  const ownerEmail = lic?.valid ? lic.ownerEmail : null;
  let admin: { email: string; name: string | null } | null = null;
  if (ownerEmail) {
    const ownerRow = await db.get(
      "SELECT name FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
      [ownerEmail],
    ) as { name: string | null } | undefined;
    admin = { email: ownerEmail, name: ownerRow?.name ?? null };
  }

  // Optional auth — surface the caller's identity if a session cookie
  // or Bearer key is present; tolerate anonymous callers.
  const callerId = await resolveCallerUserId(c);
  let me: {
    email: string;
    name: string | null;
    is_admin: boolean;
  } | null = null;
  if (callerId) {
    const row = await db.get(
      "SELECT email, name FROM users WHERE id = ?",
      [callerId],
    ) as
      | { email: string; name: string | null }
      | undefined;
    if (row) {
      me = {
        email: row.email,
        name: row.name,
        is_admin: isLicenseAdminEmail(row.email),
      };
    }
  }

  return c.json({
    claimed: !!admin,
    admin,
    me,
  });
});

// POST /auth/password — change own password and invalidate all sessions
authRoutes.post("/password", authMiddleware, async (c) => {
  const body = await c.req.json<{ current?: string; next?: string }>();
  if (!body.current || !body.next) {
    throw new ValidationError("current and next are required");
  }
  assertValidPassword(body.next, "new password");

  const db = getDb();
  const userId = c.get("userId");
  const user = await db.get(
    "SELECT password_hash FROM users WHERE id = ?",
    [userId],
  ) as { password_hash: string } | undefined;
  if (!user) throw new ValidationError("User not found");

  const check = await verifyPassword(body.current, user.password_hash);
  // 400, not 401: a wrong *current password* is a validation failure on this
  // form, not an expired session. Returning 401 made the client's global
  // handler treat it as "logged out" and bounce the user to login, swallowing
  // the real error.
  if (!check.ok) {
    throw new ValidationError("Current password is incorrect");
  }

  // Reject a no-op change: the new password must differ from the current one.
  // Compare against the stored hash so it also catches next === current even
  // when `current` was typed differently (it can't be — current was just
  // verified — but this stays correct if that check ever changes).
  const sameAsCurrent = await verifyPassword(body.next, user.password_hash);
  if (sameAsCurrent.ok) {
    throw new ValidationError(
      "new password must be different from the current password",
    );
  }

  const newHash = await hashPassword(body.next);
  // Clear is_invited: choosing your own password is the real "claim" moment for
  // an invited teammate (invite no longer routes through /auth/register). This
  // is what makes the /auth/invite 409 guard fire on a re-invite — otherwise a
  // teammate who claimed via temp-password→change-password stays is_invited=1
  // forever and a later re-invite would silently clobber their chosen password.
  await db.run("UPDATE users SET password_hash = ?, is_invited = 0 WHERE id = ?", [
    newHash,
    userId,
  ]);
  // Force logout everywhere so a stolen session cookie from a prior
  // compromise is immediately invalidated by the password change.
  await deleteAllSessionsForUser(userId);
  clearSessionCookie(c);

  return c.json({ ok: true });
});

// POST /auth/admin/reset-password/:userId — license-admin sets/resets another
// user's password IN-PLATFORM (no email server, no forgot-password flow). If
// no password is supplied, a temporary one is generated and returned ONCE for
// the admin to copy and hand over. The target's sessions are invalidated so a
// prior login/cookie stops working. The hash is never returned.
authRoutes.post("/admin/reset-password/:userId", async (c) => {
  const callerId = await resolveCallerUserId(c);
  if (!callerId) {
    return c.json({ error: "Authentication required." }, 401);
  }
  if (!(await isLicenseAdminUserId(callerId))) {
    return c.json(
      { error: "Only the license-admin user can reset passwords." },
      403,
    );
  }

  const targetId = c.req.param("userId");
  const db = getDb();
  const target = await db.get(
    "SELECT id, email FROM users WHERE id = ?",
    [targetId],
  ) as { id: string; email: string } | undefined;
  if (!target) return c.json({ error: "User not found" }, 404);

  let supplied: string | undefined;
  try {
    supplied = (await c.req.json<{ password?: string }>()).password;
  } catch {
    supplied = undefined;
  }
  if (supplied !== undefined) {
    assertValidPassword(supplied);
  }
  // Readable 16-char temp secret when the admin doesn't supply one.
  const generated = supplied ? null : uuid().replace(/-/g, "").slice(0, 16);
  const newPassword = supplied ?? generated!;

  const newHash = await hashPassword(newPassword);
  // Atomically set the new hash and REVOKE the user's API keys — a reset
  // covers the compromised-account case, so a stolen key must stop working
  // too (the user re-issues a key after signing in). Sessions are cleared
  // separately below.
  await db.transaction(async (tx) => {
    await tx.run("UPDATE users SET password_hash = ? WHERE id = ?", [
      newHash,
      target.id,
    ]);
  });
  await deleteAllSessionsForUser(target.id);

  trackEvent("admin.reset_password", { adminId: callerId, userId: target.id });

  return c.json({
    ok: true,
    email: target.email,
    keys_revoked: false,
    // Plaintext returned ONCE, only when the server generated it.
    temporary_password: generated ?? undefined,
  });
});

// DELETE /auth/users/:userId — license-admin removes a user entirely
// (in-platform, no email). Revokes ALL access — API keys, sessions, steward
// rows, collaborator grants — then deletes the user. Blocked if the target is
// the caller, or still OWNS nests (transfer/delete those first) to avoid
// orphaning nest data. Authored docs live on disk under the nest and are
// unaffected.
authRoutes.delete("/users/:userId", async (c) => {
  const callerId = await resolveCallerUserId(c);
  if (!callerId) {
    return c.json({ error: "Authentication required." }, 401);
  }
  if (!(await isLicenseAdminUserId(callerId))) {
    return c.json(
      { error: "Only the license-admin user can remove users." },
      403,
    );
  }
  const targetId = c.req.param("userId");
  if (targetId === callerId) {
    return c.json({ error: "You can't remove your own admin account." }, 400);
  }

  const db = getDb();
  const target = await db.get(
    "SELECT id, email FROM users WHERE id = ?",
    [targetId],
  ) as { id: string; email: string } | undefined;
  if (!target) return c.json({ error: "User not found" }, 404);

  const ownedNests = (
    await db.get(
      "SELECT COUNT(*) AS c FROM nests WHERE user_id = ?",
      [target.id],
    ) as { c: number }
  ).c;
  if (ownedNests > 0) {
    return c.json(
      {
        error: `This user owns ${ownedNests} nest${ownedNests === 1 ? "" : "s"}. Transfer or delete them before removing the user.`,
        owned_nests: ownedNests,
      },
      409,
    );
  }

  await db.transaction(async (tx) => {
    await tx.run(
      "DELETE FROM stewards WHERE user_id = ? OR lower(user_email) = lower(?)",
      [target.id, target.email],
    );
    await tx.run("DELETE FROM nest_collaborators WHERE user_id = ?", [
      target.id,
    ]);
    await tx.run("DELETE FROM api_keys WHERE user_id = ?", [target.id]);
    await tx.run("DELETE FROM users WHERE id = ?", [target.id]);
  });
  await deleteAllSessionsForUser(target.id);

  trackEvent("admin.remove_user", { adminId: callerId, userId: target.id });

  return c.json({ ok: true, email: target.email });
});

// POST /auth/invite — admin-only, create a user + API key for them by email
authRoutes.post("/invite", async (c) => {
  const body = await c.req.json<{ email?: string; label?: string }>();
  if (!body.email) throw new ValidationError("email is required");
  const email = normalizeEmail(body.email);

  const callerId = await resolveCallerUserId(c);
  if (!callerId) {
    return c.json(
      {
        error:
          "Authentication required. Sign in with the admin account that owns the installed PromptOwl license to invite teammates.",
      },
      401,
    );
  }
  const db = getDb();
  if (!(await isLicenseAdminUserId(callerId))) {
    return c.json(
      {
        error:
          "Only the license-admin user can invite teammates. Contact the admin who installed the PromptOwl license on this server to issue invitations.",
      },
      403,
    );
  }

  // Find user by email (case-insensitive).
  const existing = await db.get(
    "SELECT id, email, is_invited FROM users WHERE LOWER(email) = ?",
    [email],
  ) as { id: string; email: string; is_invited: number } | undefined;

  // A fully-established user (one who claimed their own password) already has a
  // working login — don't silently clobber it from the invite flow. Point the
  // admin at Reset password instead.
  if (existing && existing.is_invited === 0) {
    return c.json(
      {
        error:
          "A user with this email already exists. Use Reset password to issue them a new password.",
      },
      409,
    );
  }

  // Issue a PASSWORD, not an API key. The admin adds teammates so they can log
  // in; teammates mint their own API keys (for CLI/MCP/Hootie) after signing in.
  // Readable 16-char temporary password, returned ONCE for the admin to hand
  // over. Re-inviting a not-yet-claimed user refreshes it (so "delete + re-add"
  // / re-invite now produces a working credential).
  const tempPassword = uuid().replace(/-/g, "").slice(0, 16);
  const passwordHash = await hashPassword(tempPassword);

  let userId: string;
  if (existing) {
    userId = existing.id;
    await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [
      passwordHash,
      userId,
    ]);
  } else {
    userId = uuid();
    await db.run(
      "INSERT INTO users (id, email, name, password_hash, is_invited) VALUES (?, ?, ?, ?, 1)",
      [userId, email, null, passwordHash],
    );
  }

  trackEvent("admin.invite", { adminId: callerId, email });

  return c.json(
    {
      temporary_password: tempPassword,
      user: { id: userId, email },
      message:
        "Share this temporary password securely. Your teammate signs in with their email + this password, then can change it and create their own API key.",
    },
    201,
  );
});

// GET /auth/teammates — admin-only, list all users + their keys
authRoutes.get("/teammates", async (c) => {
  const callerId = await resolveCallerUserId(c);
  if (!callerId) {
    return c.json(
      {
        error:
          "Authentication required. Sign in with the admin account that owns the installed PromptOwl license to view teammates.",
      },
      401,
    );
  }

  const db = getDb();
  if (!(await isLicenseAdminUserId(callerId))) {
    return c.json(
      {
        error:
          "Only the license-admin user can view the teammates list. Contact the admin who installed the PromptOwl license on this server.",
      },
      403,
    );
  }

  const teammates = await db.all(
    `SELECT u.id, u.email, u.name, u.is_invited,
         (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id) as key_count,
         (SELECT MAX(last_used_at) FROM api_keys WHERE user_id = u.id) as last_active
       FROM users u
       WHERE u.id != ?
       ORDER BY u.created_at DESC`,
    [ANON_USER_ID],
  ) as Array<{
      id: string;
      email: string;
      name: string | null;
      is_invited: number;
      key_count: number;
      last_active: string | null;
    }>;

  // Steward emails assigned to any nest but without any way to
  // authenticate on this server yet — i.e. no claimed user account
  // (is_invited = 0, password set via /auth/register) AND no api_key
  // (admin hasn't issued one via /auth/invite-teammate). If either
  // path exists, the steward can act and shouldn't be flagged.
  const pendingStewards = await db.all(
    `SELECT DISTINCT s.user_email AS email
         FROM stewards s
        WHERE s.is_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM users u
             WHERE lower(u.email) = lower(s.user_email)
               AND (
                 u.is_invited = 0
                 OR EXISTS (
                   SELECT 1 FROM api_keys k WHERE k.user_id = u.id
                 )
               )
          )
        ORDER BY s.user_email`,
  ) as Array<{ email: string }>;

  // Sort admins first; underlying SQL is_admin column is unreliable
  // (license-derived), so resolve in JS after the map.
  const enriched = teammates
    .map((t) => ({ ...t, is_admin: isLicenseAdminEmail(t.email) }))
    .sort((a, b) => Number(b.is_admin) - Number(a.is_admin));

  return c.json({
    teammates: enriched,
    pending_stewards: pendingStewards.map((p) => p.email),
  });
});
