import { randomBytes, createHash, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";

const KEY_PREFIX = "cnst_";
// Work factor of 12 in production (best-practice as of 2026). Under the
// test runner (pure-JS bcryptjs) 12 rounds make register/login hooks slow
// enough to trip Vitest timeouts, so drop to a cheap factor — the hash
// algorithm being exercised is identical, only the cost differs.
const BCRYPT_ROUNDS = process.env.VITEST ? 4 : 12;

// ─── API keys ─────────────────────────────────────────────────────────────
// API keys are cryptographically random 32-byte secrets (256 bits). Because
// the secret is high-entropy, plain SHA-256 is a safe, fast storage hash —
// bcrypt would add cost with no security benefit for random inputs.

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function getKeyPrefix(key: string): string {
  return key.slice(0, 12) + "...";
}

/**
 * Extract the raw key from an `Authorization: Bearer cnst_<hex>` header.
 * Returns null if the header doesn't have the expected shape — prevents
 * "Bearer foo1234" from being silently accepted as "foo1234".
 */
export function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const BEARER = "Bearer ";
  if (!header.startsWith(BEARER)) return null;
  const token = header.slice(BEARER.length);
  if (!token.startsWith(KEY_PREFIX)) return null;
  // cnst_ + 64 hex chars = 69 chars; allow a little slack for future format
  // changes but reject obviously-short inputs.
  if (token.length < KEY_PREFIX.length + 32) return null;
  return token;
}

// ─── Passwords ────────────────────────────────────────────────────────────
// Bcrypt with a work factor of 12 (current best-practice as of 2026).
// verifyPassword is the single entry point — it also transparently accepts
// legacy SHA-256-with-salt hashes ("<salthex>:<sha256hex>") for an upgrade
// path; callers should re-hash on successful legacy login to migrate the
// stored value lazily.

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (isBcrypt(stored)) {
    return { ok: await bcrypt.compare(password, stored), needsRehash: false };
  }
  // Legacy format: "<salthex>:<sha256hex>" — verify with timing-safe compare
  // and flag for re-hashing on the caller side.
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return { ok: false, needsRehash: false };
  const attempt = createHash("sha256")
    .update(salt + password)
    .digest("hex");
  return {
    ok: timingSafeEqualHex(hash, attempt),
    needsRehash: true,
  };
}

function isBcrypt(stored: string): boolean {
  return (
    stored.startsWith("$2a$") ||
    stored.startsWith("$2b$") ||
    stored.startsWith("$2y$")
  );
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// ─── Request verification ─────────────────────────────────────────────────
// One gate every /auth/keys route runs before touching the table, so the
// rules for what a key request may do live in exactly one place instead of
// being re-derived per route.

/** Ceiling on live keys per user. Generous — the point is to stop a runaway
 *  client minting unbounded rows, not to ration credentials. */
export const MAX_API_KEYS_PER_USER = 20;
const MAX_LABEL_LENGTH = 60;

export interface ApiKeyRow {
  id: string;
  key_prefix: string;
  nest_id: string | null;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

export type KeyRequestAction = "generate" | "fetch" | "update";

export type KeyRequestCheck =
  | { ok: true; label: string | null; key: ApiKeyRow | null }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Verify a key request and normalise its inputs.
 *
 * - `generate` — validates the label and enforces MAX_API_KEYS_PER_USER.
 * - `update`   — resolves `keyId` to a row the caller actually owns. With no
 *                `keyId` and exactly one key on the account it targets that
 *                key, which keeps single-key clients working unchanged.
 * - `fetch`    — label/ownership are moot; returns ok so callers can run the
 *                same gate on every route without branching.
 *
 * Returns the resolved row and cleaned label rather than throwing, so routes
 * stay flat: `if (!check.ok) return c.json({ error }, check.status)`.
 */
export async function verifyKeyRequest(
  db: {
    get(sql: string, params?: unknown[]): Promise<unknown>;
    all(sql: string, params?: unknown[]): Promise<unknown[]>;
  },
  userId: string,
  opts: { action: KeyRequestAction; label?: unknown; keyId?: string | null },
): Promise<KeyRequestCheck> {
  const label = normalizeKeyLabel(opts.label);
  if (label === INVALID_LABEL) {
    return {
      ok: false,
      status: 400,
      error: `Label must be a string of at most ${MAX_LABEL_LENGTH} characters.`,
    };
  }

  if (opts.action === "fetch") return { ok: true, label, key: null };

  const rows = (await db.all(
    "SELECT id, key_prefix, nest_id, label, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at ASC, id ASC",
    [userId],
  )) as ApiKeyRow[];

  if (opts.action === "generate") {
    if (rows.length >= MAX_API_KEYS_PER_USER) {
      return {
        ok: false,
        status: 409,
        error: `You already have ${MAX_API_KEYS_PER_USER} API keys. Revoke one before creating another.`,
      };
    }
    return { ok: true, label, key: null };
  }

  // update (rotate / revoke)
  if (opts.keyId) {
    const match = rows.find((r) => r.id === opts.keyId);
    if (!match) return { ok: false, status: 404, error: "Key not found" };
    return { ok: true, label, key: match };
  }
  if (rows.length === 1) return { ok: true, label, key: rows[0] };
  if (rows.length === 0) {
    return { ok: false, status: 404, error: "No API key to rotate." };
  }
  return {
    ok: false,
    status: 400,
    error: "You have several API keys — say which one to rotate (key_id).",
  };
}

const INVALID_LABEL = Symbol("invalid-label") as unknown as string;

function normalizeKeyLabel(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return INVALID_LABEL;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LABEL_LENGTH) return INVALID_LABEL;
  return trimmed;
}
