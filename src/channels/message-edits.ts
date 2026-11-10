/**
 * Editing and deleting a channel message (PO-1196, team chat C1).
 *
 * EDIT — the author only (message-access.ts isAuthor: same login, and an
 * agent only what it wrote). The body each edit replaces is kept in
 * `message_edits`, readable by any member (`messageHistory`); the live row
 * gains `edited_at`. The message's mention index is rebuilt from the new
 * text: a name the edit ADDED is notified and gets its My Work row (and an
 * agent it added is woken — the wake-up ledger is per message and handle, so
 * a handle already woken by this message is not woken again); a name the
 * edit removed loses its open row; a name kept is left alone.
 *
 * DELETE — the author, or a nest owner/admin (moderation, recorded as such).
 * A TOMBSTONE, never a removed row: the body is blanked, `deleted_at` /
 * `deleted_by` / `deleted_reason` are set, and the thread, its other
 * messages and the message's place in the timeline are kept. Its mention
 * rows, reactions, pins and saves go at once, so it leaves My Work and
 * search; its edit history is kept but no longer served.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { nowMsExpr } from "../db/sql.js";
import { canOpenNode, notifyComment } from "../governance/mention-notify.js";
import { indexCommentMentions } from "../mentions/mention-index.js";
import { wakeMentionedAgents, type WakeOutcome } from "../stream/agent-wake.js";
import { deserializeClient, serializeClient } from "../shared/client-metadata.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { newMentions } from "../shared/mentions.js";
import { canSeeRoster, listNestPeople } from "../nests/people-service.js";
import type { ActorLabel } from "./actor-label.js";
import { broadcastRefusal, indexBroadcast } from "./broadcast.js";
import type { ChannelNewMessage } from "./channel-service.js";
import {
  EDIT_LIMIT,
  RateLimitedError,
  assertMayAct,
  assertNotDeleted,
  isAuthor,
  isModerator,
  locateMessage,
  memberOrRefuse,
  viewOf,
  type ActingCaller,
} from "./message-access.js";
import { displayNames, namedActor, normHandle, resolveBodyMentions } from "./message-meta.js";
import type { MentionOutcome } from "./post-message.js";

/** The longest message body an edit may store. */
export const MAX_MESSAGE_LENGTH = 20_000;

const NOT_YOURS = "Only the person who wrote a message can change it (an agent, only what it wrote itself).";

export interface EditedMessage {
  message: ChannelNewMessage;
  /** What each @name in the new text reaches; `notified` only for names the edit added. */
  mentions: MentionOutcome[];
}

export async function editMessage(
  caller: ActingCaller,
  channel: unknown | null,
  rawId: unknown,
  rawBody: unknown,
  baseUrl?: string,
): Promise<EditedMessage> {
  if (typeof rawBody !== "string" || !rawBody.trim()) throw new ValidationError("body is required — the new text of the message.");
  const body = rawBody.trim();
  if (body.length > MAX_MESSAGE_LENGTH) throw new ValidationError(`body is at most ${MAX_MESSAGE_LENGTH} characters.`);
  await memberOrRefuse(caller, `chat-edit:${caller.userId}`, EDIT_LIMIT, "edits");
  const located = await locateMessage(caller, channel, rawId);
  await assertMayAct(caller, located);
  assertNotDeleted(located);
  if (!isAuthor(caller, located.row)) throw new ForbiddenError(NOT_YOURS);
  // An `@channel` added by an edit is bounded exactly as in a post.
  const broadcast = await broadcastRefusal(caller.nestId, body, caller.userId);
  if (broadcast) throw broadcast.status === 429 ? new RateLimitedError(broadcast.error, broadcast.retryAfter ?? 60) : new ValidationError(broadcast.error);

  const { nestId } = caller;
  const nodeId = located.node.id;
  const previous = located.row.body;
  const db = getDb();
  const added = newMentions(previous, body);
  if (previous === body) {
    // Nothing to change: no history row, no re-index, no fan-out.
    const message = await viewOf(caller, located);
    return { message, mentions: await outcomes(caller, nodeId, body, [], 0, new Map()) };
  }
  {
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO message_edits (id, nest_id, comment_id, body, edited_by, client_json, replaced_at)
         VALUES (?, ?, ?, ?, ?, ?, ${nowMsExpr(db)})`,
        [uuid(), nestId, located.row.id, previous, caller.userEmail, serializeClient(caller.client)],
      );
      await tx.run(`UPDATE annotation_comments SET body = ?, edited_at = ${nowMsExpr(db)} WHERE id = ?`, [body, located.row.id]);
    });
  }

  // Re-index who it names from the new text. A name that was already there
  // keeps the message's own time, so an earlier "mark done" or reply still
  // covers it; a name the edit ADDED is stamped with the edit's time, so it
  // is open for that person now.
  const stamp = (await db.get("SELECT edited_at FROM annotation_comments WHERE id = ?", [located.row.id])) as { edited_at: string } | undefined;
  const addedSet = new Set(added.map((n) => n.toLowerCase()));
  await db.run("DELETE FROM comment_mentions WHERE comment_id = ?", [located.row.id]);
  await indexCommentMentions({
    nestId,
    nodeId,
    threadId: located.row.thread_id,
    commentId: located.row.id,
    body,
    authorEmail: caller.userEmail,
    at: (name) => (addedSet.has(name.toLowerCase()) && stamp?.edited_at ? stamp.edited_at : undefined),
  });
  const reached = await indexBroadcast({ nestId, nodeId, threadId: located.row.thread_id, commentId: located.row.id, body, authorEmail: caller.userEmail });
  if (added.length) {
    await notifyComment({ nestId, nodeId, body, actorEmail: caller.userEmail, baseUrl, channel: true, onlyNames: added });
  }
  const wakes: Map<string, WakeOutcome> = await wakeMentionedAgents({ nestId, nodeId, threadId: located.row.thread_id, commentId: located.row.id });

  // Re-read, so the view carries the stored body and edited_at.
  const message = await viewOf(caller, await locateMessage(caller, channel, located.row.id));
  return { message, mentions: await outcomes(caller, nodeId, body, added, reached, wakes) };
}

async function outcomes(
  caller: ActingCaller,
  nodeId: string,
  body: string,
  added: string[],
  reached: number,
  wakes: Map<string, WakeOutcome>,
): Promise<MentionOutcome[]> {
  const { nestId } = caller;
  const mayKnow = await canSeeRoster(nestId, caller.userId, caller.userEmail, await listNestPeople(nestId)).catch(() => false);
  if (!mayKnow) return [];
  const isNew = new Set(added.map((n) => n.toLowerCase()));
  const me = caller.userEmail.toLowerCase();
  const out: MentionOutcome[] = [];
  for (const m of (await resolveBodyMentions(nestId, [body], { broadcast: true }).catch(() => [[]]))[0] ?? []) {
    if (m.everyone) {
      out.push({ name: m.name, kind: "everyone", reached });
    } else if (m.person) {
      const p = m.person;
      const notified =
        isNew.has(m.name.toLowerCase()) &&
        !!p.userId &&
        p.email.toLowerCase() !== me &&
        (await canOpenNode(nestId, nodeId, p.userId, p.email).catch(() => false));
      out.push({ name: m.name, kind: "person", display_name: p.name?.trim() || p.email, notified });
    } else {
      const wake = wakes.get(normHandle(m.name));
      if (m.agent || wake === "sent") out.push({ name: m.name, kind: "agent", wake: wake ?? (m.agent?.wakeable ? "skipped" : "no_webhook") });
      else out.push({ name: m.name, kind: "nobody" });
    }
  }
  return out;
}

export interface MessageHistory {
  message_id: string;
  /** Newest replacement first: the body each edit replaced, when, and by whom. */
  edits: Array<{ body: string; replaced_at: string; by: ActorLabel }>;
}

/** The bodies a message had before its edits; members only, and not for a tombstone. */
export async function messageHistory(caller: ActingCaller, channel: unknown | null, rawId: unknown): Promise<MessageHistory> {
  const located = await locateMessage(caller, channel, rawId);
  if (located.row.deleted_at) throw new NotFoundError("Message not found");
  const rows = (await getDb().all(
    "SELECT body, edited_by, client_json, replaced_at FROM message_edits WHERE comment_id = ? ORDER BY replaced_at DESC, id DESC LIMIT 200",
    [located.row.id],
  )) as Array<{ body: string; edited_by: string; client_json: string | null; replaced_at: string }>;
  const names = await displayNames(rows.map((r) => r.edited_by));
  const edits = [];
  for (const r of rows) {
    const { actor } = await namedActor(r.edited_by, deserializeClient(r.client_json), names);
    edits.push({ body: r.body, replaced_at: r.replaced_at, by: actor });
  }
  return { message_id: located.row.id, edits };
}

export interface DeletedMessage {
  message: ChannelNewMessage;
}

export async function deleteMessage(caller: ActingCaller, channel: unknown | null, rawId: unknown): Promise<DeletedMessage> {
  await memberOrRefuse(caller, `chat-edit:${caller.userId}`, EDIT_LIMIT, "deletions");
  const located = await locateMessage(caller, channel, rawId);
  await assertMayAct(caller, located);
  if (located.row.deleted_at) throw new ConflictError("This message was already deleted.");
  const author = isAuthor(caller, located.row);
  const moderator = !author && (await isModerator(caller));
  if (!author && !moderator) throw new ForbiddenError("Only the person who wrote a message, or a nest owner or admin, can delete it.");
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE annotation_comments SET body = '', deleted_at = ${nowMsExpr(db)}, deleted_by = ?, deleted_reason = ? WHERE id = ?`,
      [caller.userEmail, moderator ? "moderation" : "author", located.row.id],
    );
    await tx.run("DELETE FROM comment_mentions WHERE comment_id = ?", [located.row.id]);
    await tx.run("DELETE FROM message_reactions WHERE comment_id = ?", [located.row.id]);
    // Its pins and saves (node_pins, migration 088), and its earlier texts.
    await tx.run("DELETE FROM node_pins WHERE message_id = ?", [located.row.id]);
    await tx.run("DELETE FROM message_edits WHERE comment_id = ?", [located.row.id]);
    // The inbox rows its @mentions raised name the thread, never the text
    // (mention-notify.ts; the excerpt goes only into email and connector
    // deliveries, which are already sent).
  });
  const row = (await db.get(
    "SELECT deleted_at, deleted_by, deleted_reason FROM annotation_comments WHERE id = ?",
    [located.row.id],
  )) as { deleted_at: string; deleted_by: string; deleted_reason: string };
  return { message: await viewOf(caller, { ...located, row: { ...located.row, body: "", ...row } }) };
}
