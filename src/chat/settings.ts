/**
 * Per-nest chat setting (team chat harness C2, PO-1197).
 *
 * The server switch (`config.TEAM_CHAT_ENABLED`) turns the harness on for
 * every nest; a nest's owner or admin can turn it off for that one nest
 * (`PATCH /nests/:id/chat/settings { chat: false }`). No row means on. Off
 * means off: the nest middleware answers 404 for every channel, conversation
 * and chat route of that nest, and the MCP tools say not found.
 */
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { resolveNestAccess } from "../shared/access.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";

export interface NestChatSettings {
  chat: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

async function row(nestId: string): Promise<{ chat_enabled: number; updated_by: string | null; updated_at: string | null } | undefined> {
  return (await getDb().get("SELECT chat_enabled, updated_by, updated_at FROM chat_nest_settings WHERE nest_id = ?", [nestId])) as
    | { chat_enabled: number; updated_by: string | null; updated_at: string | null }
    | undefined;
}

/** Is chat on for this nest: the server switch, and the nest hasn't turned it off. */
export async function nestChatEnabled(nestId: string): Promise<boolean> {
  if (!config.TEAM_CHAT_ENABLED) return false;
  const r = await row(nestId).catch(() => undefined);
  return !r || Number(r.chat_enabled) !== 0;
}

export async function getNestChatSettings(nestId: string): Promise<NestChatSettings> {
  const r = await row(nestId);
  return { chat: !r || Number(r.chat_enabled) !== 0, updated_by: r?.updated_by ?? null, updated_at: r?.updated_at ?? null };
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

export async function setNestChat(nestId: string, userId: string, byEmail: string, input: { chat?: unknown }): Promise<NestChatSettings> {
  if (typeof input.chat !== "boolean") throw new ValidationError("chat must be a boolean");
  await assertNestAdmin(nestId, userId);
  const db = getDb();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO chat_nest_settings (nest_id, chat_enabled, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (nest_id) DO UPDATE SET chat_enabled = excluded.chat_enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [nestId, input.chat ? 1 : 0, byEmail.toLowerCase(), now],
  );
  return getNestChatSettings(nestId);
}
