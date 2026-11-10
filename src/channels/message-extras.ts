/**
 * What every channel message read carries beyond its text since the team
 * chat harness C1 (PO-1196): its reactions, whether it is pinned, whether the
 * READER saved it, its permalink, and its edit / tombstone state.
 *
 * One batched read per concern for a page of messages (the timeline builds
 * 50 at a time), so the per-message cost is a map lookup. The reaction `by`
 * list is the first ten reactors' labels (the agent's, when one reacted);
 * `count` is the whole number.
 *
 * `url` is the in-app permalink the C3 harness opens:
 * `/nest/<nest_id>/channels?channel=<name>&thread=<thread_id>&message=<id>`.
 */
import { getDb } from "../db/client.js";
import { deserializeClient } from "../shared/client-metadata.js";
import { displayNames, namedActor } from "./message-meta.js";

/** Most reactors named per emoji; the count is still the whole number. */
export const REACTION_BY_MAX = 10;

export interface ReactionView {
  emoji: string;
  count: number;
  /** The reader reacted with it. */
  me: boolean;
  /** Who reacted, by label ("<agent>, on behalf of <person>" when an agent
   *  did), earliest first, at most REACTION_BY_MAX. */
  by: string[];
}

export type DeletedBy = "author" | "moderator";

export interface MessageExtras {
  reactions: ReactionView[];
  pinned: boolean;
  /** Whether the READER saved it — private to them. */
  saved: boolean;
  url: string;
  edited_at: string | null;
  deleted: boolean;
  deleted_at: string | null;
  /** Who removed it: the author, or a nest owner/admin (moderation). */
  deleted_by: DeletedBy | null;
}

export interface MessageStateRow {
  id: string;
  thread_id: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  deleted_reason?: string | null;
}

export function messageUrl(nestId: string, channelName: string, threadId: string, messageId: string): string {
  return `/nest/${encodeURIComponent(nestId)}/channels?channel=${encodeURIComponent(channelName)}&thread=${encodeURIComponent(
    threadId,
  )}&message=${encodeURIComponent(messageId)}`;
}

export function deletedByOf(reason: string | null | undefined): DeletedBy | null {
  if (!reason) return null;
  return reason === "moderation" ? "moderator" : "author";
}

interface ReactionRow {
  comment_id: string;
  emoji: string;
  user_id: string;
  author: string;
  client_json: string | null;
}

/** The reactions on each of these messages, as the reader sees them. */
export async function reactionsFor(callerUserId: string, commentIds: string[]): Promise<Map<string, ReactionView[]>> {
  const out = new Map<string, ReactionView[]>();
  if (commentIds.length === 0) return out;
  const rows = (await getDb().all(
    `SELECT comment_id, emoji, user_id, author, client_json FROM message_reactions
      WHERE comment_id IN (${commentIds.map(() => "?").join(", ")})
      ORDER BY created_at ASC, user_id ASC`,
    commentIds,
  )) as ReactionRow[];
  if (rows.length === 0) return out;
  const names = await displayNames(rows.map((r) => r.author));
  // Per message, per emoji, in order of first appearance.
  const grouped = new Map<string, Map<string, { count: number; me: boolean; by: string[] }>>();
  for (const r of rows) {
    const perMessage = grouped.get(r.comment_id) ?? new Map();
    grouped.set(r.comment_id, perMessage);
    const g = perMessage.get(r.emoji) ?? { count: 0, me: false, by: [] as string[] };
    perMessage.set(r.emoji, g);
    g.count += 1;
    if (r.user_id === callerUserId) g.me = true;
    if (g.by.length < REACTION_BY_MAX) {
      const { actor } = await namedActor(r.author, deserializeClient(r.client_json), names);
      g.by.push(actor.label);
    }
  }
  for (const [id, perMessage] of grouped) {
    out.set(id, [...perMessage.entries()].map(([emoji, g]) => ({ emoji, count: g.count, me: g.me, by: g.by })));
  }
  return out;
}

async function idSet(sql: string, params: unknown[]): Promise<Set<string>> {
  const rows = (await getDb().all(sql, params as any)) as Array<{ comment_id: string }>;
  return new Set(rows.map((r) => r.comment_id));
}

/**
 * The extras for a page of messages of ONE channel. `rows` carry the
 * message's own state columns (edited_at, deleted_*); the rest is read here.
 */
export async function messageExtras(
  caller: { nestId: string; userId: string },
  channelName: string,
  rows: MessageStateRow[],
): Promise<Map<string, MessageExtras>> {
  const out = new Map<string, MessageExtras>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(", ");
  const [reactions, pinned, saved] = await Promise.all([
    reactionsFor(caller.userId, ids),
    idSet(`SELECT comment_id FROM message_pins WHERE nest_id = ? AND comment_id IN (${marks})`, [caller.nestId, ...ids]),
    idSet(`SELECT comment_id FROM saved_messages WHERE user_id = ? AND comment_id IN (${marks})`, [caller.userId, ...ids]),
  ]);
  for (const r of rows) {
    const deleted = !!r.deleted_at;
    out.set(r.id, {
      // A tombstone carries nothing of what it was.
      reactions: deleted ? [] : reactions.get(r.id) ?? [],
      pinned: !deleted && pinned.has(r.id),
      saved: !deleted && saved.has(r.id),
      url: messageUrl(caller.nestId, channelName, r.thread_id, r.id),
      edited_at: r.edited_at ?? null,
      deleted,
      deleted_at: r.deleted_at ?? null,
      deleted_by: deleted ? deletedByOf(r.deleted_reason) : null,
    });
  }
  return out;
}
