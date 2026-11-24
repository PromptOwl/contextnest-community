/**
 * A plugin's system identity on a nest. Enabling a plugin provisions a named
 * system ("Plugin: <displayName>") through the same service layer as Settings
 * → Systems (auth/systems.ts): a service principal with a cnst_sys_ key and a
 * write grant on this one nest. Plugin runs act as that principal, so the
 * governance a system gets — editor tier, review on a governed nest, its own
 * attribution, no admin routes — is exactly what a plugin gets.
 *
 * The run happens in-process, so the minted key is never handed out; an admin
 * sees the system in the nest's Systems list and can rotate or revoke it
 * there. Revoking it stops the plugin (a run refuses), and re-enabling the
 * plugin provisions a fresh one.
 */
import { getDb } from "../db/client.js";
import {
  createSystem,
  revokeSystem,
  MAX_SYSTEM_NAME_LENGTH,
  type SystemInfo,
} from "../auth/systems.js";
import { resolveNestPermission, permissionLevel } from "../shared/access.js";
import { ConflictError, ForbiddenError, ValidationError } from "../shared/errors.js";

export interface PluginSystem {
  id: string;
  name: string;
  email: string;
  capability: "read" | "write";
}

const systemName = (displayName: string) => `Plugin: ${displayName}`.slice(0, MAX_SYSTEM_NAME_LENGTH);

/** The system behind a row, or null when it was never made or has been revoked. */
export async function pluginSystem(systemUserId: string | null | undefined): Promise<PluginSystem | null> {
  if (!systemUserId) return null;
  const row = (await getDb().get(
    `SELECT sa.user_id AS id, sa.name, u.email, sa.capability
       FROM system_accounts sa JOIN users u ON u.id = sa.user_id
      WHERE sa.user_id = ?`,
    [systemUserId],
  )) as PluginSystem | undefined;
  return row ?? null;
}

function refused(r: { status: number; error: string }): Error {
  if (r.status === 403) return new ForbiddenError(r.error);
  if (r.status === 409) return new ConflictError(r.error);
  return new ValidationError(r.error);
}

/** Reuse the row's live system, else create one. The actor must administer the nest. */
export async function ensurePluginSystem(opts: {
  nestId: string;
  displayName: string;
  current: string | null;
  actorId: string;
  actorCapability?: string;
}): Promise<PluginSystem> {
  const live = await pluginSystem(opts.current);
  if (live) return live;
  const r = await createSystem({
    actorId: opts.actorId,
    actorCapability: opts.actorCapability,
    name: systemName(opts.displayName),
    capability: "write",
    nestIds: [opts.nestId],
  });
  if (!r.ok) throw refused(r);
  const s: SystemInfo = r.system;
  return { id: s.id, name: s.name, email: s.email, capability: s.capability };
}

/**
 * The email a run writes as. Refuses (409) when the system is gone or no
 * longer holds write on this nest — an admin revoked it or narrowed it, and
 * the plugin must not quietly fall back to some other identity.
 */
export async function runAuthor(nestId: string, systemUserId: string | null): Promise<string> {
  const sys = await pluginSystem(systemUserId);
  if (!sys) {
    throw new ConflictError("This plugin's system identity was revoked. Re-enable the plugin to provision a new one.");
  }
  if (permissionLevel(await resolveNestPermission(nestId, sys.id)) < permissionLevel("write")) {
    throw new ConflictError(`This plugin's system identity (${sys.name}) no longer has write access to this nest.`);
  }
  return sys.email;
}

/** Retire the system when the plugin is removed. Already gone is fine. */
export async function retirePluginSystem(systemUserId: string | null, actorId: string, actorCapability?: string): Promise<void> {
  if (!(await pluginSystem(systemUserId))) return;
  const r = await revokeSystem({ actorId, actorCapability, systemId: systemUserId! });
  if (!r.ok && r.status !== 404) throw refused(r);
}
