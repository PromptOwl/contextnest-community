import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { isServerAdminUserId } from "../shared/access.js";
import { getLicenseOwnerEmail } from "./license.js";

/**
 * What a licensing problem says, and to whom.
 *
 * A lapsed, expired or suspended license is a conversation between PromptOwl
 * and the customer's admin — not something to put in front of their people.
 * Everyone else gets one neutral sentence with no licensing vocabulary in it;
 * the license owner and server admins get the specifics and who to talk to.
 */
export const NEUTRAL_READ_ONLY =
  "This workspace is read-only right now. Your administrator has been notified.";

/** What an admin is told when PromptOwl has been unreachable past the offline limit. */
export function offlineLockMessage(since: string): string {
  return `This server hasn't reached PromptOwl to check its license since ${since}, so it is read-only after 24 hours offline. Reading still works and nothing has been deleted. Allow outbound HTTPS to ${config.PROMPTOWL_API_URL}; writing comes back on the next successful check.`;
}

/**
 * May this caller see why the server is read-only, and fix it? Server admins
 * (open mode, the license owner, superadmins) — plus the owner of the installed
 * key even after it lapsed, since a lapsed license no longer makes them admin
 * and they are exactly the person who has to act.
 */
export async function canSeeLicenseDetail(
  userId: string | null | undefined,
): Promise<boolean> {
  if (config.AUTH_MODE === "open") return true;
  if (!userId) return false;
  try {
    if (await isServerAdminUserId(userId)) return true;
    const owner = getLicenseOwnerEmail();
    if (!owner) return false;
    const row = (await getDb().get("SELECT email FROM users WHERE id = ?", [
      userId,
    ])) as { email?: string } | undefined;
    return !!row?.email && row.email.toLowerCase() === owner.toLowerCase();
  } catch {
    return false;
  }
}
