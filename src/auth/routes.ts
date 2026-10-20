import { Hono, type Context } from "hono";
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
  verifyKeyRequest,
  normalizeCapability,
  parseCapability,
  insertApiKey,
  MAX_EXCHANGE_KEYS_PER_NEST,
} from "./keys.js";
import { resolveMcpTicketUser, looksLikeTicket } from "./mcp-ticket.js";
import { authMiddleware, type AuthEnv } from "./middleware.js";
import { NEST_SCOPED_KEY_CODE } from "./nest-scope-guard.js";
import {
  buildClearSessionCookie,
  buildOidcMarkerCookie,
  buildPromptowlMarkerCookie,
  buildPromptowlTokenCookie,
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
import { config, isEmailish } from "../config.js";
import { trackEvent } from "../telemetry/tracker.js";
import {
  getCurrentLicense,
  isLicenseAdminEmail,
  isLicenseAdminUserId,
} from "./license.js";
import { isSuperAdmin } from "../governance/access-service.js";
// Guards the people-management surfaces below so a granted superadmin gets the
// same operator powers as the license owner (see shared/access.ts).
import {
  isServerAdminUserId,
  resolveNestPermission,
  permissionLevel,
} from "../shared/access.js";
import { tryConsume, isLimited, recordFailure, clear } from "../shared/rate-limit.js";
import { verifySsoTicket, isValidTicketSub } from "./sso-token.js";
import { ssoCandidates } from "./community-sites.js";
import { oidcRoutes } from "./oidc.js";
import { handleTokenExchange } from "./token-exchange.js";
import { clientIp } from "../shared/request-ip.js";
import { ANON_USER_ID } from "../shared/constants.js";
import { isEmailConfigured } from "../notify/email.js";
import { createInvitedUser } from "./invited-user.js";
import { requestBaseUrl } from "../shared/base-url.js";

/** is_admin for user-facing payloads: license admin OR superadmin. */
function isServerAdminEmail(email: string): boolean {
  return isLicenseAdminEmail(email) || isSuperAdmin(email);
}

// Auth-endpoint rate limits. Keyed on IP for anonymous attempts + email
// on login (so brute-forcing one email from a botnet still clamps).
const LOGIN_LIMIT = { max: 5, windowMs: 15 * 60_000 };       // 5 / 15 min
const REGISTER_LIMIT = { max: 3, windowMs: 60 * 60_000 };    // 3 / hr
const DEVICE_LIMIT = { max: 10, windowMs: 15 * 60_000 };     // 10 / 15 min

/**
 * Scopes this server asks PromptOwl to limit its device tokens to — the least
 * it can function with: identify the user who signed in, and read the teams
 * they own so they can be imported. See PROMPTOWL_TOKEN_COOKIE in sessions.ts
 * for where the resulting token lives and why.
 */
const PROMPTOWL_SCOPES = ["user:read", "teams:read"];

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

// clientIp lives in ../shared/request-ip.ts (proxy headers → TCP peer →
// "unknown") — shared with the OIDC endpoints so every auth entry point
// keys its rate limits identically.

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
  // Log out means log out of PromptOwl access too. Every logout path funnels
  // through here, so the token cookie can't outlive the session that set it —
  // otherwise the next person on a shared browser inherits it.
  c.header(
    "Set-Cookie",
    buildPromptowlTokenCookie("", { secure: isSecureRequest(c), clear: true }),
    { append: true },
  );
  c.header(
    "Set-Cookie",
    buildPromptowlMarkerCookie({ secure: isSecureRequest(c), clear: true }),
    { append: true },
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

// Generic OIDC SSO (Microsoft Entra ID / Google / any spec-compliant IdP) —
// GET /auth/oidc/login + GET /auth/oidc/callback. Separate from the PromptOwl
// ticket flow at GET /auth/sso below. See src/auth/oidc.ts.
authRoutes.route("/oidc", oidcRoutes);

// POST /auth/token-exchange — RFC-8693-style: an IdP (Entra/Google) ID token for
// an already-authenticated user → a short-lived scoped MCP bearer, no second
// login. Unauthenticated (the subject_token IS the credential). Feature-flagged
// OFF. See src/auth/token-exchange.ts.
authRoutes.post("/token-exchange", handleTokenExchange);

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
          "Self-registration is disabled on this server. If you were invited, sign in with the temporary password from your invite email, or continue with PromptOwl using that email. Otherwise ask your admin for an invite.",
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
  if (!isEmailish(body.email)) {
    throw new ValidationError("Enter a valid email address.");
  }
  assertValidPassword(body.password);
  const email = normalizeEmail(body.email);

  // With SSO live and a domain allowlist, a password account is held to the
  // same allowlist — otherwise "open" would let any outside address in
  // around the IdP.
  const allowedDomains = config.OIDC_CONFIGURED ? config.OIDC_ALLOWED_DOMAINS : [];
  if (
    allowedDomains.length > 0 &&
    !allowedDomains.includes(email.slice(email.lastIndexOf("@") + 1))
  ) {
    return c.json(
      {
        error:
          "This server only accepts accounts from its organisation's email domains. Sign in with single sign-on, or ask your admin for an invite.",
      },
      403,
    );
  }

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
            "You've been invited to this server. Sign in with the temporary password from your invite email, or continue with PromptOwl using this email. Your admin can reset the password if you don't have it.",
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
        is_admin: isServerAdminEmail(email),
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
    "SELECT id, email, name, password_hash, is_admin, is_invited, is_service FROM users WHERE LOWER(email) = ?",
    [emailLower],
  ) as
    | {
      id: string;
      email: string;
      name: string | null;
      password_hash: string;
      is_admin: number;
      is_invited: number;
      is_service?: number | null;
    }
    | undefined;

  // Service identities (systems, access keys, personas) never sign in. Their
  // placeholder hash can't verify anyway; this says so explicitly, with the
  // same answer as a wrong password — no oracle for "this is a system".
  const check = user && !user.is_service
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

  // NOTE: is_invited is cleared inside createSession (below) — the shared
  // claim point for every sign-in flow (password, PromptOwl, OIDC).

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
      is_admin: isServerAdminEmail(user.email),
    },
  });
});

// POST /auth/logout — clear the current browser session
authRoutes.post("/logout", async (c) => {
  const sessionId = getSessionIdFromRequest(c);
  if (sessionId) await deleteSession(sessionId);
  clearSessionCookie(c);
  // Also clear the OIDC SSO marker so it can't linger past a local logout.
  // (SSO sessions normally sign out via GET /auth/oidc/logout, which does
  // the IdP round-trip; this is the fallback path.)
  c.header(
    "Set-Cookie",
    buildOidcMarkerCookie({ secure: isSecureRequest(c), clear: true }),
    { append: true },
  );
  return c.json({ ok: true });
});

// ─── External-client API keys ────────────────────────────────────────────
//
// A user may hold several keys — one per place they connect from — so losing
// the plaintext for one client no longer forces a rotate that silently kills
// every other client. Every route below runs verifyKeyRequest first; that
// helper owns the label rules, the per-user ceiling, and ownership lookup.

// A nest-scoped key must never manage keys — minting or rotating is how it
// would trade itself for a whole-account key. The app-wide nestScopedKeyGuard
// already refuses these paths; this is the belt to that brace, right where the
// escalation would happen.
function refuseNestScopedCaller(c: Context<AuthEnv>) {
  if (!c.get("nestScope")) return null;
  return c.json(
    {
      error:
        "This API key is scoped to one nest and can't create, rotate, list or revoke API keys. Use a key for all your nests, or the web app.",
      code: NEST_SCOPED_KEY_CODE,
    },
    403,
  );
}

// A key may only be scoped to a nest its owner can actually reach. Without
// this a caller could mint a key "for" someone else's nest id — useless today
// (the gate still applies the owner's own permission) but a confusing record,
// and a latent grant the day that nest is shared with them. Missing and
// inaccessible answer the same 404 so this is no existence oracle.
async function checkKeyNest(
  userId: string,
  nestId: string,
): Promise<{ error: string; status: 400 | 404 } | null> {
  if (typeof nestId !== "string" || !nestId.trim()) {
    return { error: "nest_id must be a nest id.", status: 400 };
  }
  const row = (await getDb().get("SELECT id FROM nests WHERE id = ?", [nestId])) as
    | { id: string }
    | undefined;
  const reachable =
    !!row &&
    (config.AUTH_MODE === "open" ||
      (await resolveNestPermission(nestId, userId)) !== "none");
  if (!reachable) {
    return {
      error: "Nest not found — you can only scope a key to a nest you have access to.",
      status: 404,
    };
  }
  return null;
}

// POST /auth/keys — mint another external-client API key.
//
// The plaintext is shown ONCE on creation and never retrievable again —
// the server stores only sha256(key).
authRoutes.post("/keys", authMiddleware, async (c) => {
  const body = await c.req
    .json<{ label?: string; nest_id?: string; capability?: string }>()
    .catch(() => ({}) as { label?: string; nest_id?: string; capability?: string });
  const refused = refuseNestScopedCaller(c);
  if (refused) return refused;
  const db = getDb();
  const userId = c.get("userId");

  // A read-only credential mints nothing — not even another read key — so a
  // leaked read key can't be laundered into a fresh (or broader) one.
  if (c.get("keyCapability") === "read") {
    return c.json(
      { error: "A read-only API key cannot create or rotate API keys." },
      403,
    );
  }

  const capability = parseCapability(body.capability, "write");
  if (!capability) {
    return c.json({ error: 'capability must be "read" or "write".' }, 400);
  }
  const nestId = body.nest_id || null;
  if (capability === "read" && !nestId) {
    return c.json(
      { error: "A read-only key must be scoped to one nest (nest_id)." },
      400,
    );
  }

  const check = await verifyKeyRequest(db, userId, {
    action: "generate",
    label: body.label,
  });
  if (!check.ok) return c.json({ error: check.error }, check.status);
  if (body.nest_id) {
    const bad = await checkKeyNest(userId, body.nest_id);
    if (bad) return c.json({ error: bad.error }, bad.status);
  }

  const keyId = uuid();
  const { apiKey, keyPrefix } = await insertApiKey(db, {
    id: keyId,
    userId,
    nestId,
    label: check.label,
    capability,
    origin: "manual",
  });

  return c.json(
    {
      id: keyId,
      api_key: apiKey,
      key_prefix: keyPrefix,
      label: check.label,
      nest_id: nestId,
      capability,
    },
    201,
  );
});

// POST /auth/keys/exchange — trade a PromptOwl MCP service ticket for a
// nest-scoped key (CU-wdqcq01afw).
//
// Lets PromptOwl (TheOwl) hand a signed-in user a "predefined nest endpoint":
// it presents the same short-lived HS256 ticket the per-nest MCP transport
// accepts (scope "mcp", aud = PUBLIC_BASE_URL, existing user by email) and
// gets back a durable cnst_ key bound to ONE nest, read-only by default. The
// key is minted only if the user already holds at least the asked-for
// permission on that nest — the exchange never grants access, it only narrows
// what the user already has into a credential. Capped at
// MAX_EXCHANGE_KEYS_PER_NEST live keys per (user, nest); past that, 429.
// Exchange mints a DURABLE credential, so only PromptOwl's secret
// (OFFICIAL_COMMUNITY_SSO_SECRET) is accepted — never the server's own
// MCP_SIGNING_SECRET — and only read keys.
const EXCHANGE_LIMIT = { max: 120, windowMs: 60_000 }; // per IP
const exchangesInFlight = new Set<string>();

authRoutes.post("/keys/exchange", async (c) => {
  if (!tryConsume(`key-exchange:ip:${clientIp(c)}`, EXCHANGE_LIMIT)) {
    return c.json({ error: "Too many exchange attempts, try again later" }, 429);
  }
  const secrets = config.OFFICIAL_COMMUNITY_SSO_SECRET
    ? [config.OFFICIAL_COMMUNITY_SSO_SECRET]
    : [];
  if (secrets.length === 0) {
    return c.json(
      { error: "PromptOwl ticket exchange is not configured on this server." },
      503,
    );
  }
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!looksLikeTicket(token)) {
    return c.json({ error: "A PromptOwl MCP service ticket is required." }, 401);
  }
  const resolved = await resolveMcpTicketUser(token, secrets);
  if (!resolved.ok) {
    return c.json(
      resolved.code ? { error: resolved.error, code: resolved.code } : { error: resolved.error },
      resolved.status,
    );
  }
  const userId = resolved.userId;

  const body = await c.req
    .json<{ nest_id?: unknown; label?: unknown; capability?: unknown }>()
    .catch(() => ({}) as { nest_id?: unknown; label?: unknown; capability?: unknown });
  const nestId = typeof body.nest_id === "string" ? body.nest_id.trim() : "";
  if (!nestId) return c.json({ error: "nest_id is required." }, 400);
  const capability = parseCapability(body.capability, "read");
  if (!capability) {
    return c.json({ error: 'capability must be "read" or "write".' }, 400);
  }
  if (capability !== "read") {
    return c.json({ error: "Ticket exchange only issues read keys." }, 400);
  }

  // Same resolver the /nests access gate uses. A missing nest resolves to
  // "none", so an unknown id and a forbidden one answer the same 403.
  const permission = await resolveNestPermission(nestId, userId);
  if (permissionLevel(permission) < permissionLevel(capability)) {
    return c.json(
      {
        error: `You need ${capability} access to this nest to get a ${capability} key for it.`,
      },
      403,
    );
  }

  // The count and insert below span awaits; serialise per (user, nest) so
  // concurrent exchanges can't slip past the cap.
  const lockKey = `${userId}:${nestId}`;
  if (exchangesInFlight.has(lockKey)) {
    return c.json({ error: "Another exchange for this nest is in progress." }, 429);
  }
  exchangesInFlight.add(lockKey);
  try {
  const db = getDb();
  const live = (await db.get(
    "SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND nest_id = ? AND origin = 'exchange'",
    [userId, nestId],
  )) as { n: number | string } | undefined;
  if (Number(live?.n ?? 0) >= MAX_EXCHANGE_KEYS_PER_NEST) {
    return c.json(
      {
        error: `This account already has ${MAX_EXCHANGE_KEYS_PER_NEST} PromptOwl-issued keys for this nest. Reuse one, or revoke old ones in Connect.`,
      },
      429,
    );
  }

  // Labels must be unique per user; an exchange without one gets a
  // recognisable, collision-free default.
  const label =
    body.label === undefined || body.label === null || body.label === ""
      ? `PromptOwl ${capability} key ${uuid().slice(0, 8)}`
      : body.label;
  const check = await verifyKeyRequest(db, userId, { action: "exchange", label });
  if (!check.ok) return c.json({ error: check.error }, check.status);

  const keyId = uuid();
  const { apiKey, keyPrefix } = await insertApiKey(db, {
    id: keyId,
    userId,
    nestId,
    label: check.label,
    capability,
    origin: "exchange",
  });
  trackEvent("api_key.exchange", { userId, nestId, capability });

  const base = config.PUBLIC_BASE_URL || requestBaseUrl(c.req.url);
  return c.json(
    {
      key: apiKey,
      id: keyId,
      key_prefix: keyPrefix,
      label: check.label,
      nest_id: nestId,
      capability,
      mcp_url: `${base}/nests/${nestId}/mcp`,
    },
    201,
  );
  } finally {
    exchangesInFlight.delete(lockKey);
  }
});

// POST /auth/keys/rotate — replace ONE key, leaving the caller's others alone.
//
// `key_id` picks the target. Omitting it is only unambiguous when the account
// holds exactly one key (the pre-multi-key clients), which verifyKeyRequest
// resolves; with several keys and no key_id it 400s rather than guessing.
authRoutes.post("/keys/rotate", authMiddleware, async (c) => {
  const body = await c.req
    .json<{ label?: string; nest_id?: string | null; key_id?: string }>()
    .catch(() => ({}) as { label?: string; nest_id?: string | null; key_id?: string });
  const refused = refuseNestScopedCaller(c);
  if (refused) return refused;
  const db = getDb();
  const userId = c.get("userId");

  if (c.get("keyCapability") === "read") {
    return c.json(
      { error: "A read-only API key cannot create or rotate API keys." },
      403,
    );
  }

  const check = await verifyKeyRequest(db, userId, {
    action: "update",
    label: body.label,
    keyId: body.key_id,
  });
  if (!check.ok) return c.json({ error: check.error }, check.status);
  const prior = check.key!;
  if ("nest_id" in body && body.nest_id) {
    const bad = await checkKeyNest(userId, body.nest_id);
    if (bad) return c.json({ error: bad.error }, bad.status);
  }
  // A rotate replaces the secret, never the capability: a read key stays read.
  const capability = normalizeCapability(prior.capability);

  const apiKey = generateApiKey();
  const keyId = uuid();

  // Scope resolution: field absent → keep the prior scope; explicitly null
  // (or "") → clear to a user-level key; a nest id → scope to that nest.
  // The old `body.nest_id ?? prior` collapsed "clear it" into "keep it",
  // leaving no way to un-scope a key.
  const nestScope =
    "nest_id" in body ? body.nest_id || null : prior.nest_id;
  if (capability === "read" && !nestScope) {
    return c.json(
      { error: "A read-only key must stay scoped to one nest (nest_id)." },
      400,
    );
  }

  // verifyKeyRequest resolved `prior` outside this transaction, so the row can
  // be gone by the time we get here — a concurrent rotate or revoke of the same
  // key. Insisting the DELETE actually removed something keeps rotate a
  // replacement: without it the INSERT would still run and leave an extra live
  // key, which is the opposite of what a rotate promises.
  const replaced = await db.transaction(async (tx) => {
    const removed = await tx.run(
      "DELETE FROM api_keys WHERE id = ? AND user_id = ?",
      [prior.id, userId],
    );
    if (removed.changes === 0) return false;
    await tx.run(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, nest_id, label, capability, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        keyId,
        userId,
        hashApiKey(apiKey),
        getKeyPrefix(apiKey),
        nestScope,
        check.label ?? prior.label,
        capability,
        prior.origin === "exchange" ? "exchange" : "manual",
      ],
    );
    return true;
  });

  if (!replaced) {
    return c.json(
      { error: "That key no longer exists — reload and try again." },
      404,
    );
  }

  return c.json({
    id: keyId,
    api_key: apiKey,
    key_prefix: getKeyPrefix(apiKey),
    label: check.label ?? prior.label,
    nest_id: nestScope,
    capability,
  });
});

// GET /auth/keys — return the caller's key metadata (no plaintext).
authRoutes.get("/keys", authMiddleware, async (c) => {
  const refused = refuseNestScopedCaller(c);
  if (refused) return refused;
  const db = getDb();
  const userId = c.get("userId");
  const check = await verifyKeyRequest(db, userId, { action: "fetch" });
  if (!check.ok) return c.json({ error: check.error }, check.status);

  const keys = await db.all(
    "SELECT id, key_prefix, nest_id, label, capability, origin, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at ASC, id ASC",
    [userId],
  );
  return c.json({ keys });
});

// DELETE /auth/keys/:keyId — revoke one of the caller's external keys.
authRoutes.delete("/keys/:keyId", authMiddleware, async (c) => {
  const refused = refuseNestScopedCaller(c);
  if (refused) return refused;
  const db = getDb();
  const userId = c.get("userId");
  const check = await verifyKeyRequest(db, userId, {
    action: "update",
    keyId: c.req.param("keyId"),
  });
  if (!check.ok) return c.json({ error: check.error }, check.status);

  await db.run("DELETE FROM api_keys WHERE id = ? AND user_id = ?", [
    check.key!.id,
    userId,
  ]);
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
  // Every field here is optional with a default, so a bodyless POST is a
  // perfectly good request — but c.req.json() throws on an empty body and the
  // caller would get "Request body isn't valid JSON" for asking correctly.
  const body = await c.req
    .json<{ deviceName?: string; deviceType?: string }>()
    .catch(() => ({}) as { deviceName?: string; deviceType?: string });
  const promptowlUrl = config.PROMPTOWL_API_URL.replace(/\/$/, "");

  const res = await fetch(`${promptowlUrl}/api/auth/device`, {
    method: "POST",
    headers: config.PROMPTOWL_FETCH_HEADERS,
    body: JSON.stringify({
      deviceName: body.deviceName || "ContextNest Community",
      deviceType: body.deviceType || "webapp",
      // Ask for the least this server can work with: read the profile (to
      // identify who signed in) and read teams (to import them). The token we
      // then hold — and park in the user's cookie — is refused by every other
      // PromptOwl endpoint, so it can't chat as the user or spend their
      // credits even if it leaks. An older PromptOwl ignores the field and
      // returns an unscoped token, which still works.
      scopes: PROMPTOWL_SCOPES,
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
    { headers: config.PROMPTOWL_FETCH_HEADERS },
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
    headers: { ...config.PROMPTOWL_FETCH_HEADERS, Authorization: `Bearer ${body.token}` },
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

  // Keep the token for the life of the session so team import can call
  // PromptOwl as this user without sending them back through device approval.
  // PromptOwl hands a token over exactly once, at approval — this is the only
  // moment it can be captured. It goes in the user's own cookie, not our
  // database (see PROMPTOWL_TOKEN_COOKIE), and it's scoped to reads upstream.
  c.header(
    "Set-Cookie",
    buildPromptowlTokenCookie(body.token, { secure: isSecureRequest(c) }),
    { append: true },
  );
  // Readable marker so the UI knows to offer the PromptOwl Teams tab.
  c.header(
    "Set-Cookie",
    buildPromptowlMarkerCookie({ secure: isSecureRequest(c) }),
    { append: true },
  );

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

// GET /auth/sso — one-click SSO auto-login from an official community site.
//
// THE DOMAIN LOCK. A trusted site redirects a logged-in user here with a
// short-lived JWT ticket signed with a shared secret. Only sites configured
// as official community sites (DB-managed from Server Settings, plus the
// legacy OFFICIAL_COMMUNITY_SSO_SECRET/PUBLIC_BASE_URL env-var pair for
// backward compatibility — see auth/community-sites.ts) hold a secret this
// server accepts, so:
//   - no site configured → feature disabled; bounce to the SPA with
//                     ?sso_error=not_supported so the user sees a clear
//                     message instead of a bare 404. This does NOT weaken the
//                     lock: without a matching secret no ticket can be
//                     verified, so other domains still cannot auto-login.
//   - a site matches     → verify signature + audience + expiry + one-time jti,
//                     then provision the user and start a session, exactly
//                     like the manual /auth/promptowl flow.
// On any failure the user is bounced to the app with ?sso_error=<code> so the
// SPA can show a message and fall back to manual sign-in.
authRoutes.get("/sso", async (c) => {
  const ssoError = (code: string) => c.redirect(`/?sso_error=${code}`, 302);

  const candidates = ssoCandidates();
  // No official site configured (self-hosted, or an official deployment mid
  // setup) doesn't support one-click SSO.
  if (candidates.length === 0) return ssoError("not_supported");

  if (!tryConsume(`sso:ip:${clientIp(c)}`, DEVICE_LIMIT)) {
    return ssoError("rate_limited");
  }

  const ticket = c.req.query("ticket");
  if (!ticket) return ssoError("missing_ticket");

  // Try the ticket against every configured site's secret — the same
  // "signature + expiry" gate as before, just repeated per candidate. The
  // first one whose secret verifies the signature wins; matches nothing when
  // no site's secret produced a valid signature.
  let claims: ReturnType<typeof verifySsoTicket> | undefined;
  let matched: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    try {
      claims = verifySsoTicket(ticket, candidate.secret);
      matched = candidate;
      break;
    } catch {
      // Try the next candidate — a signature mismatch here just means this
      // wasn't the site that minted the ticket.
    }
  }
  if (!claims || !matched) return ssoError("invalid_ticket");

  // Reject an MCP bearer ticket here: this endpoint mints a full login
  // session, so a `scope: "mcp"` ticket (server-to-server, no jti) must never
  // be redeemable for one. Symmetric with flexAuthWithPromptowlTicket, which
  // requires scope "mcp" — neither ticket kind can stand in for the other,
  // and neither side has to trust the issuer to keep the jti/scope invariant.
  if ((claims.scope || "") === "mcp") return ssoError("invalid_ticket");

  // Audience binding — a ticket minted for a different deployment is rejected,
  // so it can't be replayed against this one even if the secret were shared.
  // This checks the ticket's `aud` against THIS deployment's own
  // PUBLIC_BASE_URL, not the matched site's `url` — a site's `url` is a
  // display/uniqueness field for the admin list, not an audience value (see
  // SsoCandidate.url in community-sites.ts). When PUBLIC_BASE_URL is unset
  // this binding is DISABLED (the secret is the only control left), so warn
  // loudly — that's a misconfiguration, not an intended mode.
  const expectedAud = config.PUBLIC_BASE_URL;
  if (!expectedAud && !warnedMissingSsoAudience) {
    warnedMissingSsoAudience = true;
    console.warn(
      `[sso] site "${matched.label}" has a secret but PUBLIC_BASE_URL is unset — ` +
        "ticket audience binding is DISABLED. Set PUBLIC_BASE_URL to this " +
        "deployment's own URL so a ticket minted for another deployment cannot " +
        "be replayed against this one.",
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
  if (!isValidTicketSub(sub)) {
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
        is_admin: isServerAdminEmail(row.email),
      };
    }
  }

  return c.json({
    claimed: !!admin,
    admin,
    me,
  });
});

// PATCH /auth/profile — change own display name. Empty clears it (UI falls
// back to the email). authMiddleware wants a session or key, so the open-mode
// anonymous caller never reaches here — it gets 401.
authRoutes.patch("/profile", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ name?: unknown }>();
  if (typeof body.name !== "string") throw new ValidationError("name is required");
  const name = body.name.trim();
  if (name.length > 80) throw new ValidationError("name must be 80 characters or fewer");
  await getDb().run("UPDATE users SET name = ? WHERE id = ?", [name || null, userId]);
  return c.json({ ok: true, name: name || null });
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
  if (!(await isServerAdminUserId(callerId))) {
    return c.json(
      { error: "Only a server admin can reset passwords." },
      403,
    );
  }

  const targetId = c.req.param("userId");
  const db = getDb();
  const target = await db.get(
    "SELECT id, email, is_service FROM users WHERE id = ?",
    [targetId],
  ) as { id: string; email: string; is_service?: number | null } | undefined;
  if (!target) return c.json({ error: "User not found" }, 404);
  if (target.is_service) {
    return c.json(
      { error: "This is a system, not a person — it has no password. Rotate its key instead." },
      400,
    );
  }

  // Peer protection: one server admin must not be able to password-hijack
  // another (license/config/granted alike). Own password goes through
  // /auth/password; other admins are off-limits outright.
  if (target.id !== callerId && isServerAdminEmail(target.email)) {
    return c.json(
      { error: "This user is a server admin — admins can't reset each other's passwords. They can change their own via their account." },
      403,
    );
  }

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
  if (!(await isServerAdminUserId(callerId))) {
    return c.json(
      { error: "Only a server admin can remove users." },
      403,
    );
  }
  const targetId = c.req.param("userId");
  if (targetId === callerId) {
    return c.json({ error: "You can't remove your own admin account." }, 400);
  }

  const db = getDb();
  const target = await db.get(
    "SELECT id, email, is_service FROM users WHERE id = ?",
    [targetId],
  ) as { id: string; email: string; is_service?: number | null } | undefined;
  if (!target) return c.json({ error: "User not found" }, 404);
  if (target.is_service) {
    return c.json(
      { error: "This is a system, not a person — it has no password. Rotate its key instead." },
      400,
    );
  }

  // Peer protection: a server admin can't delete another server admin
  // (license/config/granted alike). Revoke their superadmin grant first
  // (config/license admins can only be demoted at the source).
  if (isServerAdminEmail(target.email)) {
    return c.json(
      { error: "This user is a server admin — admins can't remove each other. Revoke their superadmin access first." },
      403,
    );
  }

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
    // Grants this user MADE outlive them (granted_by is a FK to users): hand
    // the attribution to the nest owner so removing a person never fails on,
    // or cascades into, access they gave others — including the systems they
    // created, which belong to the nest, not to them (CU-wdqcq0538g).
    await tx.run(
      `UPDATE nest_collaborators
          SET granted_by = (SELECT n.user_id FROM nests n WHERE n.id = nest_collaborators.nest_id)
        WHERE granted_by = ?`,
      [target.id],
    );
    await tx.run("DELETE FROM api_keys WHERE user_id = ?", [target.id]);
    // Pins cascade on user_id, but stay explicit like the rows above — and a
    // database created by an earlier build of migration 039 has the FK without
    // the cascade, where this delete is the only thing standing between an
    // admin and a failed account removal.
    try {
      await tx.run("DELETE FROM nest_pins WHERE user_id = ?", [target.id]);
    } catch {
      // Table not present on a DB predating the pins migration.
    }
    // Their personal document pins (migration 069) go too — cascaded, explicit
    // like nest_pins. Editorial pins they made belong to the nest and stay
    // (pinned_by is attribution only, not a foreign key). No try/catch: the
    // migration creates the table at startup, and on Postgres a failed
    // statement aborts the whole transaction, so a catch couldn't save it.
    await tx.run("DELETE FROM node_pins WHERE user_id = ?", [target.id]);
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
  if (!isEmailish(body.email)) {
    throw new ValidationError("Enter a valid email address.");
  }
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
  if (!(await isServerAdminUserId(callerId))) {
    return c.json(
      {
        error:
          "Only a server admin can invite teammates. Contact the admin who installed the PromptOwl license on this server to issue invitations.",
      },
      403,
    );
  }

  // Find user by email (case-insensitive).
  const existing = await db.get(
    "SELECT id, email, is_invited FROM users WHERE LOWER(email) = ?",
    [email],
  ) as { id: string; email: string; is_invited: number } | undefined;

  // Never overwrite an existing user's credentials from the invite flow — not
  // even a not-yet-signed-in one, whose emailed password would silently die.
  // Re-issuing a password is the explicit Reset password action.
  if (existing) {
    return c.json(
      {
        error:
          existing.is_invited === 0
            ? `${email} is already a member of this server.`
            : `${email} is already invited but hasn't signed in yet. Use Reset password on their row to issue a new temporary password.`,
      },
      409,
    );
  }

  // Issue a PASSWORD, not an API key: teammates mint their own keys after
  // signing in. The temp password is emailed to them (when email is set up)
  // and returned ONCE for the admin to hand over otherwise.
  const inviter = (await db.get("SELECT email FROM users WHERE id = ?", [
    callerId,
  ])) as { email?: string } | undefined;
  const { id: userId, tempPassword } = await createInvitedUser(email, {
    invitedBy: inviter?.email,
    baseUrl: requestBaseUrl(c.req.url),
  });

  trackEvent("admin.invite", { adminId: callerId, email });

  return c.json(
    {
      temporary_password: tempPassword,
      user: { id: userId, email },
      // PromptOwl sign-in only counts as an option for them when it's open to all.
      promptowl_sign_in: config.PROMPTOWL_SIGN_IN_GATE === "open",
      // Email is configured, so the invite email (with this password) went out.
      emailed: isEmailConfigured(),
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
  if (!(await isServerAdminUserId(callerId))) {
    return c.json(
      {
        error:
          "Only a server admin can view the teammates list. Contact the admin who installed the PromptOwl license on this server.",
      },
      403,
    );
  }

  const teammates = await db.all(
    `SELECT u.id, u.email, u.name, u.is_invited,
         (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id) as key_count,
         -- Latest of API-key use and web-session activity (same text format).
         (SELECT MAX(t) FROM (
            SELECT last_used_at AS t FROM api_keys WHERE user_id = u.id
            UNION ALL
            SELECT last_seen_at FROM sessions WHERE user_id = u.id
          ) activity) as last_active
       FROM users u
       WHERE u.id != ?
         -- Access-key identities (CU-wdqcq0314u) are managed on their nest,
         -- not here: they are not teammates.
         AND COALESCE(u.is_service, 0) = 0
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
  // (license-derived), so resolve in JS after the map. Server-admin =
  // license admin OR superadmin, so granted/config superadmins carry the
  // Admin badge and the UI stops offering Reset password / Remove for them
  // (the backend rejects those anyway — see the target guards below).
  const enriched = teammates
    .map((t) => ({ ...t, is_admin: isServerAdminEmail(t.email) }))
    .sort((a, b) => Number(b.is_admin) - Number(a.is_admin));

  return c.json({
    teammates: enriched,
    pending_stewards: pendingStewards.map((p) => p.email),
  });
});
