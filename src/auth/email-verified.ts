import { getDb } from "../db/client.js";
import { config } from "../config.js";

/**
 * Record that an identity provider just vouched for this account's email
 * address (CU-wdqcq05rz6) — an OIDC sign-in, an IdP token exchange, or a
 * PromptOwl sign-in (PromptOwl refuses unverified accounts at its own login).
 * A password sign-up never calls this: nothing proved the address.
 *
 * Read by org contributions (src/shared/access.ts): a nest's email-domain
 * list only admits a verified address, so registering `x@acme.com` with a
 * password can't claim acme.com.
 *
 * Best-effort: a failure leaves the account unverified (fail closed) and
 * never fails the sign-in itself.
 */
export async function markEmailVerified(userId: string, source: string): Promise<void> {
  try {
    await getDb().run(
      // First verification only: keeps the original timestamp, and a sign-in
      // of an already-verified account costs no write.
      "UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL",
      [new Date().toISOString(), userId],
    );
  } catch (err) {
    console.error(
      `[auth] recording a verified email failed (user ${userId}, ${source}; sign-in continues):`,
      err,
    );
  }
}

/**
 * Does this ID token vouch for the address it carries? Sign-in already refuses
 * an explicit `email_verified: false`; this is the stricter question of
 * whether the address may then stand for a DOMAIN (org contributions).
 *
 * - `email_verified: true` → yes.
 * - Absent → only for an `email` claim (not Entra's `preferred_username`
 *   fallback, which isn't an address the IdP asserted), and only on a
 *   single-organization server. That is the documented Entra/Google trust
 *   assumption sign-in already makes. On a shared deployment the domain list
 *   is the tenant boundary, so a multi-tenant or self-registration IdP that
 *   omits the claim must not get to claim a domain.
 */
export function idpVouchesForEmail(claims: Record<string, unknown>): boolean {
  const v = claims.email_verified;
  if (v === true || v === "true") return true;
  if (v !== undefined && v !== null) return false;
  if (config.SHARED_DEPLOYMENT) return false;
  return typeof claims.email === "string" && claims.email.trim().length > 0;
}
