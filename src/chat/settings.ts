/**
 * Per-nest chat setting (team chat harness C2, PO-1197): one column on the
 * nests row, `chat_enabled` (migration 089), the way `allow_self_approve`
 * and the other per-nest switches are kept.
 *
 * The server switch (`config.TEAM_CHAT_ENABLED`) turns the harness on for
 * every nest; a nest's owner or admin can turn it off for that one nest
 * (`PATCH /nests/:id/chat/settings { chat: false }`). Off means off: the
 * nest middleware answers 404 for every channel, conversation and chat
 * route of that nest, and the MCP tools say not found.
 */
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { resolveNestAccess } from "../shared/access.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";

export interface NestChatSettings {
  chat: boolean;
}

async function column(nestId: string): Promise<boolean> {
  try {
    const r = (await getDb().get("SELECT chat_enabled FROM nests WHERE id = ?", [nestId])) as { chat_enabled: number | null } | undefined;
    return !r || r.chat_enabled === null || Number(r.chat_enabled) !== 0;
  } catch {
    // A database not yet migrated: the default, on.
    return true;
  }
}

/** Is chat on for this nest: the server switch, and the nest hasn't turned it off. */
export async function nestChatEnabled(nestId: string): Promise<boolean> {
  if (!config.TEAM_CHAT_ENABLED) return false;
  return column(nestId);
}

export async function getNestChatSettings(nestId: string): Promise<NestChatSettings> {
  return { chat: await column(nestId) };
}

/** Owner or admin of the nest, else Forbidden; no access at all, NotFound. */
export async function assertNestAdmin(nestId: string, userId: string): Promise<void> {
  if (config.AUTH_MODE === "open") return;
  const access = await resolveNestAccess(nestId, userId);
  if (access.permission === "none") throw new NotFoundError("Nest not found");
  if (access.permission !== "owner" && access.permission !== "admin") {
    throw new ForbiddenError("Only the nest's owner or an admin can change its chat setting.");
  }
}

export async function setNestChat(nestId: string, userId: string, input: { chat?: unknown }): Promise<NestChatSettings> {
  if (typeof input.chat !== "boolean") throw new ValidationError("chat must be a boolean");
  await assertNestAdmin(nestId, userId);
  await getDb().run("UPDATE nests SET chat_enabled = ? WHERE id = ?", [input.chat ? 1 : 0, nestId]);
  return getNestChatSettings(nestId);
}
