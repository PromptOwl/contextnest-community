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
import { ValidationError } from "../shared/errors.js";
import { config } from "../config.js";
import { trackEvent } from "../telemetry/tracker.js";
import { tryConsume } from "../shared/rate-limit.js";

// Auth-endpoint rate limits. Keyed on IP for anonymous attempts + email
// on login (so brute-forcing one email from a botnet still clamps).
const LOGIN_LIMIT = { max: 5, windowMs: 15 * 60_000 };       // 5 / 15 min
const REGISTER_LIMIT = { max: 3, windowMs: 60 * 60_000 };    // 3 / hr
const DEVICE_LIMIT = { max: 10, windowMs: 15 * 60_000 };     // 10 / 15 min

function clientIp(c: any): string {
  // Respect reverse-proxy headers; fall back to socket if none. Intentionally
  // trusts the first forwarded IP — deploy behind a proxy you control.
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
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

  const ip = clientIp(c);
  if (!tryConsume(`register:ip:${ip}`, REGISTER_LIMIT)) {
    return c.json({ error: "Too many registration attempts, try again later" }, 429);
  }

  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(body.email);
  if (existing) {
    throw new ValidationError("Email already registered");
  }

  const userId = uuid();
  const passwordHash = await hashPassword(body.password);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
  ).run(userId, body.email, body.name || null, passwordHash);

  const apiKey = generateApiKey();
  const keyId = uuid();
  db.prepare(
    "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?, ?)",
  ).run(keyId, userId, hashApiKey(apiKey), getKeyPrefix(apiKey), "default");

  trackEvent("user.register", { userId, email: body.email });

  return c.json(
    {
      user: { id: userId, email: body.email, name: body.name || null },
      api_key: apiKey,
    },
    201,
  );
});

// POST /auth/login
authRoutes.post("/login", async (c) => {
  const body = await c.req.json<{
    email?: string;
    password?: string;
    label?: string;
  }>();

  if (!body.email || !body.password) {
    throw new ValidationError("email and password are required");
  }

  // Clamp both by IP and by email — botnet can't parallelize against one
  // account, and a single IP can't brute-force many accounts.
  const ip = clientIp(c);
  const emailLower = body.email.toLowerCase();
  if (
    !tryConsume(`login:ip:${ip}`, LOGIN_LIMIT) ||
    !tryConsume(`login:email:${emailLower}`, LOGIN_LIMIT)
  ) {
    return c.json({ error: "Too many login attempts, try again later" }, 429);
  }

  const db = getDb();
  const user = db
    .prepare(
      "SELECT id, email, name, password_hash FROM users WHERE email = ?",
    )
    .get(body.email) as
    | { id: string; email: string; name: string | null; password_hash: string }
    | undefined;

  const check = user
    ? await verifyPassword(body.password, user.password_hash)
    : { ok: false, needsRehash: false };
  if (!user || !check.ok) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

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

  const apiKey = generateApiKey();
  const keyId = uuid();
  db.prepare(
    "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?, ?)",
  ).run(
    keyId,
    user.id,
    hashApiKey(apiKey),
    getKeyPrefix(apiKey),
    body.label || "login",
  );

  trackEvent("user.login", { userId: user.id });

  return c.json({ api_key: apiKey });
});

// POST /auth/keys — generate additional API key (authenticated)
authRoutes.post("/keys", authMiddleware, async (c) => {
  const body = await c.req.json<{ label?: string; nest_id?: string }>();
  const db = getDb();
  const apiKey = generateApiKey();
  const keyId = uuid();

  db.prepare(
    "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, nest_id, label) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    keyId,
    c.get("userId"),
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

// GET /auth/keys — list API keys (authenticated)
authRoutes.get("/keys", authMiddleware, async (c) => {
  const db = getDb();
  const keys = db
    .prepare(
      "SELECT id, key_prefix, nest_id, label, created_at, last_used_at FROM api_keys WHERE user_id = ?",
    )
    .all(c.get("userId"));
  return c.json({ keys });
});

// DELETE /auth/keys/:keyId
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

// POST /auth/promptowl — exchange PromptOwl token for cnst_* API key
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

  const db = getDb();

  let user = db
    .prepare("SELECT id, email, name FROM users WHERE email = ?")
    .get(me.email) as
    | { id: string; email: string; name: string | null }
    | undefined;

  if (!user) {
    const userId = uuid();
    const placeholderHash = await hashPassword(uuid());
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
    ).run(userId, me.email, me.name || null, placeholderHash);
    user = { id: userId, email: me.email, name: me.name || null };

    trackEvent("user.register", {
      userId,
      email: me.email,
      method: "promptowl",
    });
  } else {
    trackEvent("user.login", { userId: user.id, method: "promptowl" });
  }

  // ─── Admin claim ───
  // If no admin has claimed this server yet, the first PromptOwl-authed user
  // becomes the admin. Subsequent PromptOwl logins are regular users.
  // Atomic via a single conditional UPDATE — two concurrent claims can't
  // both succeed because the WHERE clause only matches when no admin
  // currently exists. Wrap in a transaction for durability.
  let isAdmin = false;
  const claim = db.transaction((userId: string): boolean => {
    const result = db
      .prepare(
        `UPDATE users SET is_admin = 1
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)`,
      )
      .run(userId);
    return result.changes > 0;
  });

  if (claim(user.id)) {
    isAdmin = true;
    trackEvent("admin.claim", { userId: user.id, email: user.email });
  } else {
    const userRow = db
      .prepare("SELECT is_admin FROM users WHERE id = ?")
      .get(user.id) as { is_admin: number } | undefined;
    isAdmin = !!userRow?.is_admin;
  }

  const apiKey = generateApiKey();
  const keyId = uuid();
  db.prepare(
    "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?, ?)",
  ).run(
    keyId,
    user.id,
    hashApiKey(apiKey),
    getKeyPrefix(apiKey),
    "promptowl",
  );

  return c.json({
    api_key: apiKey,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      is_admin: isAdmin,
    },
  });
});

// GET /auth/admin-status — does this server have an admin? Who am I?
authRoutes.get("/admin-status", async (c) => {
  const db = getDb();
  const admin = db
    .prepare("SELECT email, name FROM users WHERE is_admin = 1 LIMIT 1")
    .get() as { email: string; name: string | null } | undefined;

  // Check if the caller is authed — if so, return their admin status too
  const callerKey = parseBearerToken(c.req.header("Authorization"));
  let me: { email: string; is_admin: boolean } | null = null;
  if (callerKey) {
    const keyHash = hashApiKey(callerKey);
    const row = db
      .prepare(
        `SELECT u.email, u.is_admin FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.key_hash = ?`,
      )
      .get(keyHash) as { email: string; is_admin: number } | undefined;
    if (row) {
      me = { email: row.email, is_admin: !!row.is_admin };
    }
  }

  return c.json({
    claimed: !!admin,
    admin: admin ? { email: admin.email, name: admin.name } : null,
    me,
  });
});

// POST /auth/invite — admin-only, create an API key for a teammate by email
authRoutes.post("/invite", async (c) => {
  const body = await c.req.json<{ email?: string; label?: string }>();
  if (!body.email) throw new ValidationError("email is required");

  // Must be admin
  const inviteKey = parseBearerToken(c.req.header("Authorization"));
  if (!inviteKey) {
    return c.json({ error: "Admin authentication required" }, 401);
  }
  const db = getDb();
  const keyHash = hashApiKey(inviteKey);
  const caller = db
    .prepare(
      `SELECT u.id, u.is_admin FROM api_keys k
       JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ?`,
    )
    .get(keyHash) as { id: string; is_admin: number } | undefined;

  if (!caller || !caller.is_admin) {
    return c.json({ error: "Admin only" }, 403);
  }

  // Find or create user by email
  let user = db
    .prepare("SELECT id, email FROM users WHERE email = ?")
    .get(body.email) as { id: string; email: string } | undefined;

  if (!user) {
    const userId = uuid();
    const placeholderHash = await hashPassword(uuid());
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
    ).run(userId, body.email, null, placeholderHash);
    user = { id: userId, email: body.email };
  }

  const apiKey = generateApiKey();
  const keyId = uuid();
  db.prepare(
    "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?, ?)",
  ).run(keyId, user.id, hashApiKey(apiKey), getKeyPrefix(apiKey), body.label || "teammate");

  trackEvent("admin.invite", { adminId: caller.id, email: body.email });

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
  const teammatesKey = parseBearerToken(c.req.header("Authorization"));
  if (!teammatesKey) {
    return c.json({ error: "Admin authentication required" }, 401);
  }

  const db = getDb();
  const keyHash = hashApiKey(teammatesKey);
  const caller = db
    .prepare(
      `SELECT u.is_admin FROM api_keys k
       JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ?`,
    )
    .get(keyHash) as { is_admin: number } | undefined;

  if (!caller || !caller.is_admin) {
    return c.json({ error: "Admin only" }, 403);
  }

  const teammates = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.is_admin,
         (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id) as key_count,
         (SELECT MAX(last_used_at) FROM api_keys WHERE user_id = u.id) as last_active
       FROM users u
       WHERE u.id != '00000000-0000-0000-0000-000000000000'
       ORDER BY u.is_admin DESC, u.created_at DESC`,
    )
    .all() as Array<{
    id: string;
    email: string;
    name: string | null;
    is_admin: number;
    key_count: number;
    last_active: string | null;
  }>;

  // Steward emails assigned to any nest but without an API key on this
  // server — they've been delegated governance but can't log in yet.
  // Surface them so the admin can invite them with one click.
  const pendingStewards = db
    .prepare(
      `SELECT DISTINCT s.user_email AS email
         FROM stewards s
        WHERE s.is_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM users u
              JOIN api_keys k ON k.user_id = u.id
             WHERE lower(u.email) = lower(s.user_email)
          )
        ORDER BY s.user_email`,
    )
    .all() as Array<{ email: string }>;

  return c.json({
    teammates: teammates.map((t) => ({
      ...t,
      is_admin: !!t.is_admin,
    })),
    pending_stewards: pendingStewards.map((p) => p.email),
  });
});
