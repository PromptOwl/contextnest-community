import bcrypt from "bcryptjs";
import { getDb } from "../db/client.js";
import { ANON_USER_ID, ANON_EMAIL } from "../shared/constants.js";

/**
 * Ensure the anonymous/admin user exists in the database.
 * Used in open mode — all requests are attributed to this user.
 * Returns the user ID.
 *
 * The password hash is never used (the anon user has no login path) but
 * the column is NOT NULL, so we stash a one-way bcrypt placeholder.
 */
export async function ensureAnonymousUser(): Promise<string> {
  const db = getDb();

  const exists = await db.get(
    "SELECT id FROM users WHERE id = ?",
    [ANON_USER_ID],
  );

  if (!exists) {
    // hashSync keeps this function synchronous so existing middleware
    // callers don't have to change. The anon user is only inserted once.
    const placeholder = bcrypt.hashSync("anon-no-login", 4);
    await db.run(
      "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
      [ANON_USER_ID, ANON_EMAIL, "Admin", placeholder],
    );
  }

  return ANON_USER_ID;
}
