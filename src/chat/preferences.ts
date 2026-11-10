/**
 * Mute and notification preferences (team chat harness C2, PO-1197).
 *
 * Per person: a level for a nest (the default there) and, over it, a level
 * for one container (a channel or a conversation):
 *
 *   all       every message by someone else in the container drops an inbox
 *             row (kind 'comment', "X posted in #ops");
 *   mentions  (the default) only a message that @names the person does;
 *   none      nothing reaches the inbox, the mail or the team connector.
 *
 * None of this changes what is UNREAD (the channel list, /me/chat/unread) or
 * what My Work lists under Mentions: a muted mention still waits for an
 * answer; it just doesn't ping. `filterMentionRecipients` is the one hook the
 * mention fan-out calls; `notifyAllSubscribers` runs after a message lands.
 */
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { insertNotification } from "../notify/inbox.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { isChannelId, channelNameOf, isChannelNode } from "../channels/channel-node.js";
import { isNestMember } from "../channels/channel-service.js";
import { displayNames, namedActor } from "../channels/message-meta.js";
import { deserializeClient } from "../shared/client-metadata.js";
import { listVisibleNests } from "../nests/service.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import { isConversationId, isContainerMember, containerReadVerdict } from "./containers.js";
import { nestChatEnabled } from "./settings.js";

export const LEVELS = ["all", "mentions", "none"] as const;
export type NotifyLevel = (typeof LEVELS)[number];
export const DEFAULT_LEVEL: NotifyLevel = "mentions";

export interface PreferenceView {
  nest_id: string;
  /** The container (a channel node id or a conversation id), or null for the nest default. */
  conversation: string | null;
  level: NotifyLevel;
}

export interface Preferences {
  default: NotifyLevel;
  nests: Array<{ nest_id: string; level: NotifyLevel; conversations: Array<{ conversation: string; level: NotifyLevel }> }>;
}

function parseLevel(raw: unknown): NotifyLevel {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!(LEVELS as readonly string[]).includes(s)) throw new ValidationError(`level is one of ${LEVELS.join(", ")}.`);
  return s as NotifyLevel;
}

export async function getPreferences(userId: string, opts: { onlyNestId?: string | null } = {}): Promise<Preferences> {
  const rows = (await getDb().all("SELECT nest_id, ref, level FROM chat_preferences WHERE user_id = ? ORDER BY nest_id, ref", [userId])) as Array<{
    nest_id: string;
    ref: string;
    level: NotifyLevel;
  }>;
  const nests = new Map<string, Preferences["nests"][number]>();
  for (const r of rows) {
    if (opts.onlyNestId && r.nest_id !== opts.onlyNestId) continue;
    let n = nests.get(r.nest_id);
    if (!n) nests.set(r.nest_id, (n = { nest_id: r.nest_id, level: DEFAULT_LEVEL, conversations: [] }));
    if (r.ref === "") n.level = r.level;
    else n.conversations.push({ conversation: r.ref, level: r.level });
  }
  return { default: DEFAULT_LEVEL, nests: [...nests.values()] };
}

/**
 * Set one level. The nest must have chat on and the caller must be a person
 * added to it (404 otherwise — the same answer as for a nest that doesn't
 * exist); a container must be one the caller can read (404 otherwise).
 */
export async function setPreference(
  caller: { userId: string; userEmail: string },
  input: { nest_id?: unknown; conversation?: unknown; level?: unknown },
): Promise<{ preference: PreferenceView }> {
  const level = parseLevel(input.level);
  const nestId = typeof input.nest_id === "string" ? input.nest_id.trim() : "";
  if (!nestId) throw new ValidationError("nest_id is required");
  if (!(await nestChatEnabled(nestId)) || !(await isNestMember(nestId, caller.userId))) throw new NotFoundError("Nest not found");
  let ref = "";
  if (input.conversation !== undefined && input.conversation !== null && input.conversation !== "") {
    if (typeof input.conversation !== "string") throw new ValidationError("conversation must be a container id");
    ref = input.conversation.trim();
    const readable = await canReadContainer(nestId, ref, caller.userId, caller.userEmail);
    if (!readable) throw new NotFoundError("Conversation not found");
  }
  const db = getDb();
  if (level === DEFAULT_LEVEL) {
    await db.run("DELETE FROM chat_preferences WHERE user_id = ? AND nest_id = ? AND ref = ?", [caller.userId, nestId, ref]);
  } else {
    await db.run(
      `INSERT INTO chat_preferences (user_id, nest_id, ref, level, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, nest_id, ref) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
      [caller.userId, nestId, ref, level, new Date().toISOString()],
    );
  }
  return { preference: { nest_id: nestId, conversation: ref || null, level } };
}

/** Can this caller read this chat container (a channel node or a conversation)? */
export async function canReadContainer(nestId: string, container: string, userId: string, email: string): Promise<boolean> {
  if (isConversationId(container)) return isContainerMember(nestId, container, userId);
  if (!isChannelId(container)) return false;
  if (!(await isChannelNode(nestId, container))) return false;
  const verdict = await containerReadVerdict(nestId, container, userId);
  if (verdict === false) return false;
  return canOpenNode(nestId, container, userId, email).catch(() => false);
}

/** user id → effective level for this container (override, else nest default, else mentions). */
export async function levelsFor(nestId: string, container: string, userIds: string[]): Promise<Map<string, NotifyLevel>> {
  const out = new Map<string, NotifyLevel>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const rows = (await getDb().all(
    `SELECT user_id, ref, level FROM chat_preferences WHERE nest_id = ? AND ref IN ('', ?) AND user_id IN (${ids.map(() => "?").join(", ")})`,
    [nestId, container, ...ids],
  )) as Array<{ user_id: string; ref: string; level: NotifyLevel }>;
  const nest = new Map<string, NotifyLevel>();
  const own = new Map<string, NotifyLevel>();
  for (const r of rows) (r.ref === "" ? nest : own).set(r.user_id, r.level);
  for (const id of ids) out.set(id, own.get(id) ?? nest.get(id) ?? DEFAULT_LEVEL);
  return out;
}

/**
 * The hook in the mention fan-out: drop the people who muted this container
 * (or the nest). Only chat containers are looked at; a document comment is
 * never filtered. Fails open on a read error: a mention is better delivered
 * than lost.
 */
export async function filterMentionRecipients<T extends { userId: string }>(nestId: string, nodeId: string, recipients: T[]): Promise<T[]> {
  if (!config.TEAM_CHAT_ENABLED || recipients.length === 0) return recipients;
  if (!isConversationId(nodeId) && !isChannelId(nodeId)) return recipients;
  try {
    const levels = await levelsFor(nestId, nodeId, recipients.map((r) => r.userId));
    return recipients.filter((r) => levels.get(r.userId) !== "none");
  } catch {
    return recipients;
  }
}

/**
 * After a message lands in a chat container: an inbox row for everyone who
 * chose `all` there (or `all` as their nest default and nothing else for the
 * container), minus the writer and minus anyone who can't read the container.
 * Explicit rows only, so this costs nothing on a nest where nobody opted in.
 */
export async function notifyAllSubscribers(params: {
  nestId: string;
  nodeId: string;
  authorEmail: string;
  authorClientJson?: string | null;
}): Promise<number> {
  const { nestId, nodeId, authorEmail } = params;
  if (!config.TEAM_CHAT_ENABLED) return 0;
  if (!isConversationId(nodeId) && !isChannelId(nodeId)) return 0;
  try {
    const rows = (await getDb().all(
      `SELECT p.user_id, LOWER(u.email) AS email FROM chat_preferences p JOIN users u ON u.id = p.user_id
        WHERE p.nest_id = ? AND p.level = 'all' AND p.ref IN ('', ?)`,
      [nestId, nodeId],
    )) as Array<{ user_id: string; email: string }>;
    if (rows.length === 0) return 0;
    const candidates = new Map<string, string>();
    for (const r of rows) candidates.set(r.user_id, r.email);
    const levels = await levelsFor(nestId, nodeId, [...candidates.keys()]);
    const author = authorEmail.toLowerCase();
    const name = isChannelId(nodeId) ? `#${channelNameOf(nodeId)}` : "a conversation";
    const names = await displayNames([author]);
    const { actor } = await namedActor(author, deserializeClient(params.authorClientJson ?? null), names);
    let created = 0;
    for (const [userId, email] of candidates) {
      if (email === author || levels.get(userId) !== "all") continue;
      if (!(await canReadContainer(nestId, nodeId, userId, email))) continue;
      await insertNotification(
        { nestId, userEmail: email, kind: "comment", subjectId: nodeId, message: `${actor.label} posted in ${name}`, createdAt: new Date().toISOString() },
        { from: author, nodeId },
      );
      created++;
    }
    return created;
  } catch (err) {
    console.error("[chat] all-messages notification failed", nestId, nodeId, err);
    return 0;
  }
}

/** The nests a preference may be set in: the ones the caller is a person on (for the MCP default). */
export async function memberNestIds(userId: string): Promise<string[]> {
  const out: string[] = [];
  for (const n of await listVisibleNests(userId)) if (await isNestMember(n.id, userId)) out.push(n.id);
  return out;
}
