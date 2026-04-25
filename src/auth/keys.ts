import { randomBytes, createHash, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";

const KEY_PREFIX = "cnst_";
const BCRYPT_ROUNDS = 12;

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
