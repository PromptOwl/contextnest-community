import { getCurrentLicense, isSuspended } from "./license.js";
import { countBilled } from "./seats.js";

/**
 * Free tier: a small deployment can write without a PromptOwl license.
 *
 * The published Free tier is "free for up to 10 users, on our cloud or your
 * servers", so a server with no valid license keeps accepting writes while it
 * has FREE_TIER_MAX_USERS or fewer billed users — counted exactly as a Free
 * key counts them (countBilled: owners, admins, reviewers, server admins).
 * Viewers are free and never count, so sign-ups alone can't close the gate.
 * Past that, the license gate applies exactly as before.
 *
 * Every write gate (REST nest routes, server-level and per-nest MCP, workflow
 * runs) asks writesAllowed(), so the paths cannot drift apart.
 */
export const FREE_TIER_MAX_USERS = 10;

/** What an admin is told when an unlicensed server is past the Free tier. */
export const FREE_TIER_EXCEEDED_MESSAGE =
  `This server has more than ${FREE_TIER_MAX_USERS} users and no valid PromptOwl license, so writes are disabled. ` +
  `Install a license (POST /license/install) or bring the server back to ${FREE_TIER_MAX_USERS} or fewer users.`;

/** True when the server has no more billed users than the Free tier allows. */
export async function withinFreeTier(): Promise<boolean> {
  return (await countBilled()).users <= FREE_TIER_MAX_USERS;
}

/**
 * May this server accept writes right now? Never while PromptOwl's kill switch
 * is engaged; otherwise yes with a valid license, or without one while the
 * server is within the Free tier. Reads the user count only when unlicensed.
 */
export async function writesAllowed(): Promise<boolean> {
  if (isSuspended()) return false;
  if (getCurrentLicense()?.valid) return true;
  return withinFreeTier();
}
