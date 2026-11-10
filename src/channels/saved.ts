/**
 * Saved messages — a person's own "later" list across nests (PO-1196, team
 * chat C1) — are their PERSONAL pins (node_pins, scope 'user', src/nodes/
 * doc-pins.ts) with `message_id` set: the bookmark store that already exists,
 * so leaving a nest, being removed from it or deleting the account clears
 * them along with the document pins (dropPersonalPinsIfGone and the
 * account-removal cascade), and the document pin lists leave them out.
 *
 * Saving needs only to be able to read the message (a member of the nest; an
 * archived channel is fine); the list is private to the saver.
 *
 * `GET /me/saved`, the `saved` section of My Work and `context_my_work` all
 * come from `listSaved`: one query over the saver's rows in the nests they
 * can see (newest saved first, bounded), then access per distinct channel at
 * read time — a nest or channel the person can no longer read takes its rows
 * out of the list and the count at once, as the Mentions section does.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import { nowMsExpr } from "../db/sql.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { isUniqueViolation } from "../governance/stewardship-service.js";
import { channelNameOf } from "./channel-node.js";
import {
  MESSAGE_COLUMNS,
  isNestMember,
  messagesFromRows,
  type Caller,
  type ChannelNewMessage,
  type CommentRow,
} from "./channel-service.js";
import { MARK_LIMIT, assertNotDeleted, locateMessage, memberOrRefuse, viewOf, type ActingCaller } from "./message-access.js";

/** Default and largest page of saved items. */
export const SAVED_PAGE_DEFAULT = 50;
export const SAVED_PAGE_MAX = 100;
const MAX_SAVED_OFFSET = 10_000;
/** Most saved rows one read considers before access filtering. */
const MAX_SCAN = 2000;

export interface SavedItem {
  type: "saved";
  nest_id: string;
  nest_name: string;
  channel: string;
  thread_id: string;
  message: ChannelNewMessage;
  saved_at: string;
}

export interface SavedList {
  saved: SavedItem[];
  pagination: { total: number; limit: number; offset: number; has_more: boolean };
}

export async function saveMessage(caller: ActingCaller, channel: unknown | null, rawId: unknown): Promise<{ message: ChannelNewMessage }> {
  await memberOrRefuse(caller, `chat-mark:${caller.userId}`, MARK_LIMIT, "pins and saves");
  const located = await locateMessage(caller, channel, rawId);
  assertNotDeleted(located);
  const db = getDb();
  try {
    await db.run(
      `INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position, pinned_by, created_at, message_id, thread_id)
       VALUES (?, ?, ?, 'user', ?, 0, ?, ${nowMsExpr(db)}, ?, ?)`,
      [randomUUID(), caller.nestId, located.node.id, caller.userId, caller.userEmail, located.row.id, located.row.thread_id],
    );
  } catch (err) {
    // Already saved: that is what the caller asked for.
    if (!isUniqueViolation(err)) throw err;
  }
  return { message: await viewOf(caller, located) };
}

export async function unsaveMessage(caller: ActingCaller, channel: unknown | null, rawId: unknown): Promise<{ message: ChannelNewMessage }> {
  await memberOrRefuse(caller, `chat-mark:${caller.userId}`, MARK_LIMIT, "pins and saves");
  const located = await locateMessage(caller, channel, rawId);
  await getDb().run("DELETE FROM node_pins WHERE nest_id = ? AND message_id = ? AND scope = 'user' AND user_id = ?", [
    caller.nestId,
    located.row.id,
    caller.userId,
  ]);
  return { message: await viewOf(caller, located) };
}

export function parseSavedPaging(q: { limit?: unknown; offset?: unknown }): { limit: number; offset: number } {
  const l = Number(q.limit);
  const o = Number(q.offset);
  return {
    limit: Number.isFinite(l) && l >= 1 ? Math.min(Math.floor(l), SAVED_PAGE_MAX) : SAVED_PAGE_DEFAULT,
    offset: Number.isFinite(o) && o >= 0 ? Math.min(Math.floor(o), MAX_SAVED_OFFSET) : 0,
  };
}

type SavedRow = CommentRow & { nest_id: string; node_id: string; saved_at: string };

/**
 * The caller's saved messages in the given nests (id → name), newest saved
 * first, each still readable by them now; paged.
 */
export async function listSaved(params: {
  userId: string;
  email: string;
  nestNames: Map<string, string>;
  limit: number;
  offset: number;
}): Promise<SavedList> {
  const { userId, email, nestNames, limit, offset } = params;
  const nestIds = [...nestNames.keys()];
  const empty: SavedList = { saved: [], pagination: { total: 0, limit, offset, has_more: false } };
  if (nestIds.length === 0 || !userId) return empty;
  const rows = (await getDb().all(
    `SELECT ${MESSAGE_COLUMNS}, p.nest_id, p.node_id, p.created_at AS saved_at
       FROM node_pins p
       JOIN annotation_comments c ON c.id = p.message_id
      WHERE p.scope = 'user' AND p.user_id = ? AND p.message_id IS NOT NULL
        AND p.nest_id IN (${nestIds.map(() => "?").join(", ")}) AND c.deleted_at IS NULL
      ORDER BY p.created_at DESC, p.message_id DESC
      LIMIT ${MAX_SCAN}`,
    [userId, ...nestIds],
  )) as SavedRow[];
  if (rows.length === 0) return empty;

  // Access per distinct channel, and membership per nest, at read time.
  const member = new Map<string, boolean>();
  const readable = new Map<string, boolean>();
  for (const r of rows) {
    if (!member.has(r.nest_id)) member.set(r.nest_id, await isNestMember(r.nest_id, userId).catch(() => false));
    const k = `${r.nest_id}\u0000${r.node_id}`;
    if (!readable.has(k)) {
      readable.set(
        k,
        !!member.get(r.nest_id) && !!channelNameOf(r.node_id) && (await canOpenNode(r.nest_id, r.node_id, userId, email).catch(() => false)),
      );
    }
  }
  const shown = rows.filter((r) => readable.get(`${r.nest_id}\u0000${r.node_id}`));
  const page = shown.slice(offset, offset + limit);

  // Build the messages per channel (each needs its own caller scope).
  const byChannel = new Map<string, SavedRow[]>();
  for (const r of page) {
    const k = `${r.nest_id}\u0000${r.node_id}`;
    byChannel.set(k, [...(byChannel.get(k) ?? []), r]);
  }
  const built = new Map<string, ChannelNewMessage>();
  for (const [k, group] of byChannel) {
    const [nestId, nodeId] = k.split("\u0000");
    const caller: Caller = { nestId, userId, userEmail: email, crossNest: false };
    const messages = await messagesFromRows(caller, channelNameOf(nodeId)!, group);
    group.forEach((r, i) => built.set(r.id, messages[i]));
  }
  return {
    saved: page.map((r) => ({
      type: "saved" as const,
      nest_id: r.nest_id,
      nest_name: nestNames.get(r.nest_id) ?? r.nest_id,
      channel: channelNameOf(r.node_id)!,
      thread_id: r.thread_id,
      message: built.get(r.id)!,
      saved_at: r.saved_at,
    })),
    pagination: { total: shown.length, limit, offset, has_more: offset + page.length < shown.length },
  };
}
