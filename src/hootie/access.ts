/**
 * "May this person still ask about this nest?" — asked again while a Hootie
 * turn runs, not only when it starts.
 *
 * The nest middleware answers it once, as the chat request comes in. A turn
 * then makes model rounds and tool calls for up to tens of seconds, and the
 * per-node layer under them does not repeat the nest check: on a nest without
 * stewardship `canReadNode` admits any caller (access-guard.ts), by design,
 * because the middleware already ran. So someone removed from the nest
 * mid-question would keep reading it until the answer ends. The agent loop
 * calls this before every tool run and every further model round (and the
 * route before its no-tools broadening), and ends the turn when it says no.
 *
 * The rule mirrors the middleware's for the chat route: some nest permission,
 * or a document/folder share grant (a grantee's reads are scoped by
 * filterAccessible). Open mode admits everyone to any nest that exists, as
 * the middleware does. `resolveNestAccess` is one live query — no cache.
 */
import { config } from "../config.js";
import { resolveNestAccess } from "../shared/access.js";

export async function canStillAsk(nestId: string, userId: string): Promise<boolean> {
  const access = await resolveNestAccess(nestId, userId);
  if (!access.exists) return false;
  if (config.AUTH_MODE === "open") return true;
  return access.permission !== "none" || access.hasGrant;
}
