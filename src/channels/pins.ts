/**
 * Pinned messages, per channel (PO-1196, team chat C1). A member pins or
 * unpins any message in a channel they can post in (the same rule as
 * reacting); the channel's pins are listed newest first with who pinned each.
 * Pins are keyed by nest and message, so a message id from another nest is
 * simply not found here.
 */
import { getDb } from "../db/client.js";
import { nowMsExpr } from "../db/sql.js";
import {
  MESSAGE_COLUMNS,
  getReadableChannel,
  isNestMember,
  messagesFromRows,
  type Caller,
  type ChannelNewMessage,
  type ChannelView,
  type CommentRow,
} from "./channel-service.js";
import { assertMayAct, assertNotDeleted, locateMessage, viewOf, type ActingCaller } from "./message-access.js";
import { NotFoundError } from "../shared/errors.js";
import { displayNames } from "./message-meta.js";

/** Most pins a channel lists. */
export const MAX_PINS = 100;

export interface PinnedMessage {
  message: ChannelNewMessage;
  pinned_by: string;
  pinned_by_name: string;
  pinned_at: string;
}

export interface ChannelPins {
  channel: ChannelView;
  pins: PinnedMessage[];
}

export async function pinMessage(caller: ActingCaller, channel: unknown | null, rawId: unknown): Promise<{ message: ChannelNewMessage }> {
  const located = await locateMessage(caller, channel, rawId);
  await assertMayAct(caller, located);
  assertNotDeleted(located);
  const db = getDb();
  await db.run(
    `INSERT INTO message_pins (nest_id, node_id, thread_id, comment_id, pinned_by, created_at)
     VALUES (?, ?, ?, ?, ?, ${nowMsExpr(db)})
     ON CONFLICT (nest_id, comment_id) DO NOTHING`,
    [caller.nestId, located.node.id, located.row.thread_id, located.row.id, caller.userEmail],
  );
  return { message: await viewOf(caller, located) };
}

export async function unpinMessage(caller: ActingCaller, channel: unknown | null, rawId: unknown): Promise<{ message: ChannelNewMessage }> {
  const located = await locateMessage(caller, channel, rawId);
  await assertMayAct(caller, located);
  await getDb().run("DELETE FROM message_pins WHERE nest_id = ? AND comment_id = ?", [caller.nestId, located.row.id]);
  return { message: await viewOf(caller, located) };
}

/** A channel's pinned messages, newest pin first. Members only. */
export async function listPins(caller: Caller, channel: unknown): Promise<ChannelPins> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Channel not found");
  const { node, view } = await getReadableChannel(caller, channel);
  const rows = (await getDb().all(
    `SELECT ${MESSAGE_COLUMNS}, p.pinned_by, p.created_at AS pinned_at
       FROM message_pins p
       JOIN annotation_comments c ON c.id = p.comment_id
      WHERE p.nest_id = ? AND p.node_id = ? AND c.deleted_at IS NULL
      ORDER BY p.created_at DESC, p.comment_id DESC
      LIMIT ${MAX_PINS}`,
    [caller.nestId, node.id],
  )) as Array<CommentRow & { pinned_by: string; pinned_at: string }>;
  const messages = await messagesFromRows(caller, view.name, rows);
  const names = await displayNames(rows.map((r) => r.pinned_by));
  return {
    channel: view,
    pins: rows.map((r, i) => ({
      message: messages[i],
      pinned_by: r.pinned_by,
      pinned_by_name: names.get(r.pinned_by.toLowerCase()) ?? r.pinned_by,
      pinned_at: r.pinned_at,
    })),
  };
}
