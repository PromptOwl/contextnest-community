import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
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
import { isSuperAdmin } from "../governance/access-service.js";
import { tryConsume, isLimited, recordFailure, clear } from "../shared/rate-limit.js";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ANON_USER_ID } from "../shared/constants.js";

// Auth-endpoint rate limits. Keyed on IP for anonymous attempts + email
// on login (so brute-forcing one email from a botnet still clamps).
const LOGIN_LIMIT = { max: 5, windowMs: 15 * 60_000 };       // 5 / 15 min
const REGISTER_LIMIT = { max: 3, windowMs: 60 * 60_000 };    // 3 / hr
const DEVICE_LIMIT = { max: 10, windowMs: 15 * 60_000 };     // 10 / 15 min

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
function resolveCallerUserId(c: any): string | null {
  const sessionId = getSessionIdFromRequest(c);
  if (sessionId) {
    const uid = resolveSession(sessionId);
    if (uid) return uid;
  }
  const key = parseBearerToken(c.req.header("Authorization"));
  if (key) {
    const db = getDb();
    const row = db
      .prepare("SELECT user_id FROM api_keys WHERE key_hash = ?")
      .get(hashApiKey(key)) as { user_id: string } | undefined;
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
function deviceGateBlocked(c: any): { error: string; gate: string } | null {
  const gate = config.PROMPTOWL_SIGN_IN_GATE;
  if (gate === "open") return null;
  const error =
    "PromptOwl sign-in is restricted on this server. Use email and password, or contact your admin.";
  if (gate === "disabled") return { error, gate };
  // admin-only
  const callerId = resolveCallerUserId(c);
  if (callerId && !isLicenseAdminUserId(callerId)) return { error, gate };
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

export const authRoutes = new Hono<AuthEnv>();

// POST /auth/register
authRoutes.post("/register", async (c) => {
  const body = await c.req.json<{
    email?: string;
    password?: string;
    name?: string;
  }>();

  if (!body.email || !body.password) {
    throw new ValidationError("email and password are required");
  }
  const email = normalizeEmail(body.email);

  const ip = clientIp(c);
  if (!tryConsume(`register:ip:${ip}`, REGISTER_LIMIT)) {
    return c.json({ error: "Too many registration attempts, try again later" }, 429);
  }

  const db = getDb();
  const existing = db
    .prepare("SELECT id, is_invited FROM users WHERE LOWER(email) = ?")
    .get(email) as { id: string; is_invited: number } | undefined;

  let userId: string;
  const passwordHash = await hashPassword(body.password);

  if (existing && existing.is_invited === 1) {
    // Claim flow: an admin invited / shared / steward-assigned this email
    // before the person registered. Adopt the existing row so all
    // downstream FK links (api_keys, nest_collaborators, stewards) keep
    // working — just swap in the user-chosen password and clear the
    // pending flag.
    userId = existing.id;
    db.prepare(
      "UPDATE users SET password_hash = ?, name = COALESCE(?, name), is_invited = 0 WHERE id = ?",
    ).run(passwordHash, body.name || null, userId);
    trackEvent("user.register", { userId, email, claimed: true });
  } else if (existing) {
    throw new ValidationError("Email already registered");
  } else {
    userId = uuid();
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
    ).run(userId, email, body.name || null, passwordHash);
    trackEvent("user.register", { userId, email });
  }

  // Web session — browser auth lives in an httpOnly cookie. We do NOT
  // mint an external api_key here. The user can mint one on demand from
  // the Connect modal via /auth/keys.
  const sessionId = createSession(userId, c.req.header("User-Agent"));
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
  const emailLower = body.email.toLowerCase();
  const hasIp = ip !== "unknown";
  const ipKey = `login:ip:${ip}`;
  const emailKey = `login:email:${emailLower}`;
  if ((hasIp && isLimited(ipKey, LOGIN_LIMIT)) || isLimited(emailKey, LOGIN_LIMIT)) {
    return c.json({ error: "Too many login attempts, try again later" }, 429);
  }

  const db = getDb();
  const user = db
    .prepare(
      "SELECT id, email, name, password_hash, is_admin FROM users WHERE LOWER(email) = ?",
    )
    .get(emailLower) as
    | {
      id: string;
      email: string;
      name: string | null;
      password_hash: string;
      is_admin: number;
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

  // Legacy SHA-256 password? Silently upgrade to bcrypt on this successful
  // login so the DB migrates itself over time without forcing a reset.
  if (check.needsRehash) {
    try {
      const newHash = await hashPassword(body.password);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
        newHash,
        user.id,
      );
    } catch {
      // best-effort; never block login on the migration path
    }
  }

  trackEvent("user.login", { userId: user.id });

  const sessionId = createSession(user.id, c.req.header("User-Agent"));
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
  if (sessionId) deleteSession(sessionId);
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

  const existing = db
    .prepare("SELECT key_prefix FROM api_keys WHERE user_id = ?")
    .get(userId) as { key_prefix: string } | undefined;

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
  db.prepare(
    "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, nest_id, label) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    keyId,
    userId,
    hashApiKey(apiKey),
    getKeyPrefix(apiKey),
    body.nest_id || null,
    body.label || null,
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

  const prior = db
    .prepare("SELECT label, nest_id FROM api_keys WHERE user_id = ?")
    .get(userId) as { label: string | null; nest_id: string | null } | undefined;

  db.transaction(() => {
    db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(userId);
    db.prepare(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, nest_id, label) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      keyId,
      userId,
      hashApiKey(apiKey),
      getKeyPrefix(apiKey),
      body.nest_id ?? prior?.nest_id ?? null,
      body.label ?? prior?.label ?? null,
    );
  })();

  return c.json({ api_key: apiKey, key_prefix: getKeyPrefix(apiKey) });
});

// GET /auth/keys — return the caller's key metadata (no plaintext).
authRoutes.get("/keys", authMiddleware, async (c) => {
  const db = getDb();
  const keys = db
    .prepare(
      "SELECT id, key_prefix, nest_id, label, created_at, last_used_at FROM api_keys WHERE user_id = ?",
    )
    .all(c.get("userId"));
  return c.json({ keys });
});

// DELETE /auth/keys/:keyId — revoke the caller's external key.
authRoutes.delete("/keys/:keyId", authMiddleware, async (c) => {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?")
    .run(c.req.param("keyId"), c.get("userId"));

  if (result.changes === 0) {
    return c.json({ error: "Key not found" }, 404);
  }
  return c.json({ deleted: true });
});

// ─── PromptOwl Device Auth ──────────────────────────────────────────────

// POST /auth/device — initiate PromptOwl device auth
authRoutes.post("/device", async (c) => {
  const blocked = deviceGateBlocked(c);
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
  const blocked = deviceGateBlocked(c);
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

  // PROMPTOWL_SIGN_IN_GATE — optionally restrict PromptOwl sign-in. When
  // not "open", only the license owner (admin) may complete it; everyone
  // else uses email/password. Enforced HERE (the identity point) so a
  // non-admin can't even auto-provision a user via PromptOwl.
  const gate = config.PROMPTOWL_SIGN_IN_GATE;
  if (gate !== "open") {
    if (gate === "disabled" || !isLicenseAdminEmail(me.email)) {
      return c.json(
        {
          error:
            "PromptOwl sign-in is restricted on this server. Use email and password, or contact your admin.",
          gate,
        },
        403,
      );
    }
  }

  const db = getDb();
  const meEmail = normalizeEmail(me.email);

  let user = db
    .prepare("SELECT id, email, name FROM users WHERE LOWER(email) = ?")
    .get(meEmail) as
    | { id: string; email: string; name: string | null }
    | undefined;

  if (!user) {
    const userId = uuid();
    const placeholderHash = await hashPassword(uuid());
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
    ).run(userId, meEmail, me.name || null, placeholderHash);
    user = { id: userId, email: meEmail, name: me.name || null };

    trackEvent("user.register", {
      userId,
      email: me.email,
      method: "promptowl",
    });
  } else {
    trackEvent("user.login", { userId: user.id, method: "promptowl" });
  }

  // ─── Admin derivation ───
  // Admin is whoever owns the currently-installed license, not a
  // sticky DB flag. This means transferring the license to a new
  // PromptOwl account immediately demotes the old admin and promotes
  // the new owner — no manual DB cleanup required.
  let claimBlocked:
    | { reason: "license_required" }
    | { reason: "email_mismatch"; license_owner_email: string | null }
    | null = null;

  const lic = getCurrentLicense();
  let isAdmin = false;
  if (!lic?.valid) {
    claimBlocked = { reason: "license_required" };
  } else if (
    lic.ownerEmail &&
    lic.ownerEmail.toLowerCase() === me.email.toLowerCase()
  ) {
    isAdmin = true;
    trackEvent("admin.claim", { userId: user.id, email: user.email });
  } else {
    claimBlocked = {
      reason: "email_mismatch",
      license_owner_email: lic.ownerEmail,
    };
  }

  const sessionId = createSession(user.id, c.req.header("User-Agent"));
  setSessionCookie(c, sessionId);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      is_admin: isAdmin,
    },
    ...(claimBlocked ? { claim_blocked: claimBlocked } : {}),
  });
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
    const ownerRow = db
      .prepare("SELECT name FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1")
      .get(ownerEmail) as { name: string | null } | undefined;
    admin = { email: ownerEmail, name: ownerRow?.name ?? null };
  }

  // Optional auth — surface the caller's identity if a session cookie
  // or Bearer key is present; tolerate anonymous callers.
  const callerId = resolveCallerUserId(c);
  let me: {
    email: string;
    name: string | null;
    is_admin: boolean;
    is_super_admin: boolean;
  } | null = null;
  if (callerId) {
    const row = db
      .prepare("SELECT email, name FROM users WHERE id = ?")
      .get(callerId) as
      | { email: string; name: string | null }
      | undefined;
    if (row) {
      me = {
        email: row.email,
        name: row.name,
        is_admin: isLicenseAdminEmail(row.email),
        // Server admin = license admin OR an access.yaml super_admin. Drives
        // visibility of the branding panel and other server-wide controls.
        is_super_admin:
          isLicenseAdminEmail(row.email) || isSuperAdmin(row.email),
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
  if (body.next.length < 8) {
    throw new ValidationError("new password must be at least 8 characters");
  }

  const db = getDb();
  const userId = c.get("userId");
  const user = db
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .get(userId) as { password_hash: string } | undefined;
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
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    newHash,
    userId,
  );
  // Force logout everywhere so a stolen session cookie from a prior
  // compromise is immediately invalidated by the password change.
  deleteAllSessionsForUser(userId);
  clearSessionCookie(c);

  return c.json({ ok: true });
});

// POST /auth/admin/reset-password/:userId — license-admin sets/resets another
// user's password IN-PLATFORM (no email server, no forgot-password flow). If
// no password is supplied, a temporary one is generated and returned ONCE for
// the admin to copy and hand over. The target's sessions are invalidated so a
// prior login/cookie stops working. The hash is never returned.
authRoutes.post("/admin/reset-password/:userId", async (c) => {
  const callerId = resolveCallerUserId(c);
  if (!callerId) {
    return c.json({ error: "Authentication required." }, 401);
  }
  if (!isLicenseAdminUserId(callerId)) {
    return c.json(
      { error: "Only the license-admin user can reset passwords." },
      403,
    );
  }

  const targetId = c.req.param("userId");
  const db = getDb();
  const target = db
    .prepare("SELECT id, email FROM users WHERE id = ?")
    .get(targetId) as { id: string; email: string } | undefined;
  if (!target) return c.json({ error: "User not found" }, 404);

  let supplied: string | undefined;
  try {
    supplied = (await c.req.json<{ password?: string }>()).password;
  } catch {
    supplied = undefined;
  }
  if (supplied && supplied.length < 8) {
    throw new ValidationError("password must be at least 8 characters");
  }
  // Readable 16-char temp secret when the admin doesn't supply one.
  const generated = supplied ? null : uuid().replace(/-/g, "").slice(0, 16);
  const newPassword = supplied ?? generated!;

  const newHash = await hashPassword(newPassword);
  // Atomically set the new hash and REVOKE the user's API keys — a reset
  // covers the compromised-account case, so a stolen key must stop working
  // too (the user re-issues a key after signing in). Sessions are cleared
  // separately below.
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
      newHash,
      target.id,
    );
    db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(target.id);
  })();
  deleteAllSessionsForUser(target.id);

  trackEvent("admin.reset_password", { adminId: callerId, userId: target.id });

  return c.json({
    ok: true,
    email: target.email,
    keys_revoked: true,
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
  const callerId = resolveCallerUserId(c);
  if (!callerId) {
    return c.json({ error: "Authentication required." }, 401);
  }
  if (!isLicenseAdminUserId(callerId)) {
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
  const target = db
    .prepare("SELECT id, email FROM users WHERE id = ?")
    .get(targetId) as { id: string; email: string } | undefined;
  if (!target) return c.json({ error: "User not found" }, 404);

  const ownedNests = (
    db
      .prepare("SELECT COUNT(*) AS c FROM nests WHERE user_id = ?")
      .get(target.id) as { c: number }
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

  db.transaction(() => {
    db.prepare(
      "DELETE FROM stewards WHERE user_id = ? OR lower(user_email) = lower(?)",
    ).run(target.id, target.email);
    db.prepare("DELETE FROM nest_collaborators WHERE user_id = ?").run(
      target.id,
    );
    db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(target.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
  })();
  deleteAllSessionsForUser(target.id);

  trackEvent("admin.remove_user", { adminId: callerId, userId: target.id });

  return c.json({ ok: true, email: target.email });
});

// POST /auth/invite — admin-only, create a user + API key for them by email
authRoutes.post("/invite", async (c) => {
  const body = await c.req.json<{ email?: string; label?: string }>();
  if (!body.email) throw new ValidationError("email is required");
  const email = normalizeEmail(body.email);

  const callerId = resolveCallerUserId(c);
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
  if (!isLicenseAdminUserId(callerId)) {
    return c.json(
      {
        error:
          "Only the license-admin user can invite teammates. Contact the admin who installed the PromptOwl license on this server to issue invitations.",
      },
      403,
    );
  }

  // Find or create user by email
  let user = db
    .prepare("SELECT id, email FROM users WHERE LOWER(email) = ?")
    .get(email) as { id: string; email: string } | undefined;

  if (!user) {
    const userId = uuid();
    const placeholderHash = await hashPassword(uuid());
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, is_invited) VALUES (?, ?, ?, ?, 1)",
    ).run(userId, email, null, placeholderHash);
    user = { id: userId, email };
  }

  // Single api_key per user — if invitee already has one, we replace it
  // so the admin can hand a fresh plaintext to the teammate. The prior
  // key is invalidated atomically.
  const apiKey = generateApiKey();
  const keyId = uuid();
  db.transaction(() => {
    db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(user!.id);
    db.prepare(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?, ?)",
    ).run(
      keyId,
      user!.id,
      hashApiKey(apiKey),
      getKeyPrefix(apiKey),
      body.label || "teammate",
    );
  })();

  trackEvent("admin.invite", { adminId: callerId, email: body.email });

  return c.json(
    {
      api_key: apiKey,
      user: { id: user.id, email: user.email },
      message: "Copy this key and share it securely — it won't be shown again.",
    },
    201,
  );
});

// GET /auth/teammates — admin-only, list all users + their keys
authRoutes.get("/teammates", async (c) => {
  const callerId = resolveCallerUserId(c);
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
  if (!isLicenseAdminUserId(callerId)) {
    return c.json(
      {
        error:
          "Only the license-admin user can view the teammates list. Contact the admin who installed the PromptOwl license on this server.",
      },
      403,
    );
  }

  const teammates = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.is_invited,
         (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id) as key_count,
         (SELECT MAX(last_used_at) FROM api_keys WHERE user_id = u.id) as last_active
       FROM users u
       WHERE u.id != ?
       ORDER BY u.created_at DESC`,
    )
    .all(ANON_USER_ID) as Array<{
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
  const pendingStewards = db
    .prepare(
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
    )
    .all() as Array<{ email: string }>;

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
