/**
 * Pinned messages, per channel (PO-1196, team chat C1) — the document pin
 * store (node_pins, src/nodes/doc-pins.ts) applied to messages: a channel's
 * pins are EDITORIAL pins (scope 'nest') on the channel node with
 * `message_id` set, so the cascades that already exist (a nest deleted, a
 * channel node renamed) cover them, and the document pin lists leave them out
 * (`message_id IS NULL` there).
 *
 * Who may differs from document pins by the owner's rule: any member pins
 * or unpins a message in a channel they can post in (the same rule as
 * reacting), not only a curator. The channel's pins are listed newest first
 * with who pinned each. Pins are keyed by nest and message, so a message id
 * from another nest is simply not found here.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import { nowMsExpr } from "../db/sql.js";
import { isUniqueViolation } from "../governance/stewardship-service.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
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
import { MARK_LIMIT, assertMayAct, assertNotDeleted, locateMessage, memberOrRefuse, viewOf, type ActingCaller } from "./message-access.js";
import { displayNames } from "./message-meta.js";

/** Most pinned messages a channel holds (and lists). */
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
  await memberOrRefuse(caller, `chat-mark:${caller.userId}`, MARK_LIMIT, "pins and saves");
  const located = await locateMessage(caller, channel, rawId);
  await assertMayAct(caller, located);
  assertNotDeleted(located);
  const db = getDb();
  try {
    // One statement does the cap check, the position and the insert, as the
    // document pins do (doc-pins.ts pinDocument): no row when the channel's
    // list is full.
    const r = await db.run(
      `INSERT INTO node_pins (id, nest_id, node_id, scope, user_id, position, pinned_by, created_at, message_id, thread_id)
       SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), 'nest', NULL,
              COALESCE(MAX(position), -1) + 1, CAST(? AS TEXT), ${nowMsExpr(db)}, CAST(? AS TEXT), CAST(? AS TEXT)
         FROM node_pins WHERE nest_id = ? AND node_id = ? AND scope = 'nest' AND message_id IS NOT NULL
       HAVING COUNT(*) < CAST(? AS INTEGER)`,
      [randomUUID(), caller.nestId, located.node.id, caller.userEmail, located.row.id, located.row.thread_id, caller.nestId, located.node.id, MAX_PINS],
    );
    if (r.changes === 0) {
      const already = await db.get("SELECT 1 FROM node_pins WHERE nest_id = ? AND message_id = ? AND scope = 'nest'", [caller.nestId, located.row.id]);
      if (!already) throw new ValidationError(`A channel holds at most ${MAX_PINS} pinned messages — unpin one first.`);
    }
  } catch (err) {
    // Pinned twice at once, or already pinned: the pin exists, which is what
    // the caller asked for.
    if (!isUniqueViolation(err)) throw err;
  }
  return { message: await viewOf(caller, located) };
}

export async function unpinMessage(caller: ActingCaller, channel: unknown | null, rawId: unknown): Promise<{ message: ChannelNewMessage }> {
  await memberOrRefuse(caller, `chat-mark:${caller.userId}`, MARK_LIMIT, "pins and saves");
  const located = await locateMessage(caller, channel, rawId);
  await assertMayAct(caller, located);
  await getDb().run("DELETE FROM node_pins WHERE nest_id = ? AND message_id = ? AND scope = 'nest'", [caller.nestId, located.row.id]);
  return { message: await viewOf(caller, located) };
}

/** A channel's pinned messages, newest pin first. Members only. */
export async function listPins(caller: Caller, channel: unknown): Promise<ChannelPins> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Channel not found");
  const { node, view } = await getReadableChannel(caller, channel);
  const rows = (await getDb().all(
    `SELECT ${MESSAGE_COLUMNS}, p.pinned_by, p.created_at AS pinned_at
       FROM node_pins p
       JOIN annotation_comments c ON c.id = p.message_id
      WHERE p.nest_id = ? AND p.node_id = ? AND p.scope = 'nest' AND p.message_id IS NOT NULL AND c.deleted_at IS NULL
      ORDER BY p.created_at DESC, p.message_id DESC
      LIMIT ${MAX_PINS}`,
    [caller.nestId, node.id],
  )) as Array<CommentRow & { pinned_by: string | null; pinned_at: string }>;
  const messages = await messagesFromRows(caller, view.name, rows);
  const names = await displayNames(rows.map((r) => r.pinned_by ?? ""));
  return {
    channel: view,
    pins: rows.map((r, i) => ({
      message: messages[i],
      pinned_by: r.pinned_by ?? "",
      pinned_by_name: names.get((r.pinned_by ?? "").toLowerCase()) ?? r.pinned_by ?? "",
      pinned_at: r.pinned_at,
    })),
  };
}
