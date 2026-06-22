/**
 * Consumer API Key Helpers
 * ========================
 *
 * Pure crypto for the `cnst_*` consumer keys used by the marketplace
 * query endpoint. The plaintext is shown once, the hash is stored,
 * and verification is hash-compare.
 *
 * Lives in `core` so both the community package and sister apps
 * (TheOwl) consume the same generator + verifier. No DB, no I/O.
 * Returned key shape:
 *   - `plaintext`: shown to the user exactly once
 *   - `hash`: SHA-256 hex — the only artifact we persist
 *   - `prefix`: short visible label, e.g. "cnst_aB3x"
 */

import crypto from "crypto";

export interface GeneratedKey {
  /** Shown to the user exactly ONCE — can never be recovered. */
  plaintext: string;
  /** SHA-256 hex hash — what we actually store. */
  hash: string;
  /** Last-4 visible identifier, e.g. "cnst_aB3x". */
  prefix: string;
}

const PREFIX = "cnst_";
const RANDOM_BYTES = 32; // 256 bits → ~43 chars base64url

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generate a fresh consumer key. Returns the plaintext (shown to
 * the user), the hash (stored), and a visible prefix (UI label).
 */
export function generateConsumerKey(): GeneratedKey {
  const random = crypto.randomBytes(RANDOM_BYTES);
  const body = base64url(random);
  const plaintext = `${PREFIX}${body}`;
  const hash = crypto.createHash("sha256").update(plaintext).digest("hex");
  const prefix = `${PREFIX}${body.slice(0, 4)}`;
  return { plaintext, hash, prefix };
}

/**
 * Hash a plaintext key for verification. Must produce the exact
 * same output as `generateConsumerKey().hash` for the same plaintext.
 */
export function hashConsumerKey(plaintext: string): string {
  if (!plaintext) throw new Error("Cannot hash empty key");
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}
