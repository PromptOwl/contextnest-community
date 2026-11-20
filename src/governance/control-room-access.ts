/**
 * Who may make the REST reads that serve the Control room page (po-1406):
 * superadmins only (Misha, 2026-11-18), replacing the 2026-11-09 rule that let
 * nest owners and admins in (po-1186 CR2, decision 3). Since first-run
 * onboarding every user owns a nest, so that rule showed the page to everyone.
 *
 * A superadmin is a signed-in server admin, never AUTH_MODE=open (everyone is
 * an anonymous admin there), as for the message log. A key scoped to one nest
 * is an agent reading its own nest's ledger, and is let through: the routes
 * keep it inside that nest. The agent reporting routes (register, run
 * start / step / close) and every MCP tool don't call this.
 */
import type { Context } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { isServerAdminUserId } from "../shared/access.js";
import { ForbiddenError } from "../shared/errors.js";

export const CONTROL_ROOM_DENIED =
  "Only a superadmin can open the Control room. An agent reads its own nest's ledger with a key scoped to that nest, or over MCP.";

export async function mayReadControlRoom(userId: string | undefined | null, keyNestScope: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  // Scope check first: an agent's nest key reads its nest in open mode too.
  if (keyNestScope) return true;
  if (config.AUTH_MODE === "open") return false;
  return isServerAdminUserId(userId).catch((err) => {
    console.warn("[control-room] superadmin check failed:", err instanceof Error ? err.message : err);
    return false;
  });
}

/** Throws 403 unless the caller may read the Control room's page-only routes. */
export async function assertControlRoomReader(c: Context<AuthEnv>): Promise<void> {
  if (!(await mayReadControlRoom(c.get("userId"), c.get("nestScope") ?? null))) throw new ForbiddenError(CONTROL_ROOM_DENIED);
}
