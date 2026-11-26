/**
 * Editing and deleting one's own comment on a document (po-1229). A channel or
 * direct message has its own route and rules (channels/message-edits.ts); the
 * storage is the same: the replaced text goes to `message_edits`, a delete is
 * a tombstone, which a document's thread list leaves out (listThreads).
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { nowMsExpr } from "../db/sql.js";
import { isChannelNode } from "../channels/channel-node.js";
import { isConversationId } from "../chat/containers.js";
import { isAuthor, type ActingCaller } from "../channels/message-access.js";
import { MESSAGE_COLUMNS, type CommentRow } from "../channels/channel-service.js";
import { MAX_MESSAGE_LENGTH } from "../channels/message-edits.js";
import { notifyComment } from "../governance/mention-notify.js";
import { indexCommentMentions } from "../mentions/mention-index.js";
import { wakeMentionedAgents } from "../stream/agent-wake.js";
import { serializeClient } from "../shared/client-metadata.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { newMentions } from "../shared/mentions.js";
import { syncAnnotationsNode } from "./service.js";

export interface CommentAddress {
  nodeId: string;
  threadId: string;
  commentId: string;
}

/** The caller's own live comment, scoped to the URL's nest, node and thread. */
async function ownComment(caller: ActingCaller, at: CommentAddress): Promise<CommentRow> {
  if (isConversationId(at.nodeId) || (await isChannelNode(caller.nestId, at.nodeId))) {
    throw new ConflictError("Edit or delete a channel message through the channel's messages route.");
  }
  const row = (await getDb().get(
    `SELECT ${MESSAGE_COLUMNS} FROM annotation_comments c
       JOIN annotation_threads t ON t.id = c.thread_id
      WHERE c.id = ? AND t.id = ? AND t.nest_id = ? AND t.node_id = ?`,
    [at.commentId, at.threadId, caller.nestId, at.nodeId],
  )) as CommentRow | undefined;
  if (!row || row.deleted_at) throw new NotFoundError("Comment not found");
  if (!isAuthor(caller, row)) throw new ForbiddenError("Only the person who wrote a comment can change it.");
  return row;
}

export async function editComment(
  caller: ActingCaller,
  at: CommentAddress,
  rawBody: unknown,
  baseUrl?: string,
): Promise<void> {
  if (typeof rawBody !== "string" || !rawBody.trim()) throw new ValidationError("body is required");
  const body = rawBody.trim();
  if (body.length > MAX_MESSAGE_LENGTH) throw new ValidationError(`body is at most ${MAX_MESSAGE_LENGTH} characters.`);
  const row = await ownComment(caller, at);
  if (row.body === body) return;
  const { nestId, userEmail } = caller;
  const { nodeId, threadId, commentId } = at;
  const db = getDb();
  await db.transaction(async (tx) => {
    const updated = await tx.run(
      `UPDATE annotation_comments SET body = ?, edited_at = ${nowMsExpr(db)} WHERE id = ? AND deleted_at IS NULL`,
      [body, commentId],
    );
    if (updated.changes === 0) throw new ConflictError("This comment was deleted.");
    await tx.run(
      `INSERT INTO message_edits (id, nest_id, comment_id, body, edited_by, client_json, replaced_at)
       VALUES (?, ?, ?, ?, ?, ?, ${nowMsExpr(db)})`,
      [uuid(), nestId, commentId, row.body, userEmail, serializeClient(caller.client)],
    );
  });

  // As for a message: a name the edit added is open from now, a name it kept
  // stays as it was, and only the added ones are notified.
  const added = newMentions(row.body, body);
  const addedSet = new Set(added.map((n) => n.toLowerCase()));
  const stamp = (await db.get("SELECT edited_at FROM annotation_comments WHERE id = ?", [commentId])) as
    | { edited_at: string }
    | undefined;
  await db.run("DELETE FROM comment_mentions WHERE comment_id = ?", [commentId]);
  await indexCommentMentions({
    nestId,
    nodeId,
    threadId,
    commentId,
    body,
    authorEmail: userEmail,
    at: (name) => (addedSet.has(name.toLowerCase()) ? stamp?.edited_at : undefined),
  });
  if (added.length) {
    await notifyComment({ nestId, nodeId, body, actorEmail: userEmail, baseUrl, onlyNames: added });
  }
  await wakeMentionedAgents({ nestId, nodeId, threadId, commentId });
  await syncAnnotationsNode(nestId, nodeId, userEmail);
}

export async function deleteComment(caller: ActingCaller, at: CommentAddress): Promise<void> {
  await ownComment(caller, at);
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE annotation_comments SET body = '', deleted_at = ${nowMsExpr(db)}, deleted_by = ?, deleted_reason = 'author' WHERE id = ?`,
      [caller.userEmail, at.commentId],
    );
    await tx.run("DELETE FROM comment_mentions WHERE comment_id = ?", [at.commentId]);
    await tx.run("DELETE FROM message_edits WHERE comment_id = ?", [at.commentId]);
  });
  await syncAnnotationsNode(caller.nestId, at.nodeId, caller.userEmail);
}
