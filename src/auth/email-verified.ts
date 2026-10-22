import { getDb } from "../db/client.js";

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
    console.error(`[auth] recording a verified email failed (${source}; sign-in continues):`, err);
  }
}
