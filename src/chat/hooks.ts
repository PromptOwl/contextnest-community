/**
 * What the message write path calls after a message lands (team chat C2,
 * PO-1197) — the two lines in channels/post-message.ts:
 *
 *   - `indexConversationAgents`: in a conversation, every AGENT member the
 *     message doesn't already name gets a mention row, so the agent's My
 *     Work lists it and the wake-up goes out (a message to an agent in its
 *     dm is addressed to it). Runs between the mention index and the wake.
 *   - `afterPostedMessage`: the live `message.new` event (pointers only, never
 *     text) and the inbox rows for people who chose `all` on this container.
 *
 * Both best-effort: a failure never fails the post.
 */
import { getDb } from "../db/client.js";
import { justWritten } from "../mentions/mention-index.js";
import { writerHandlesOf } from "../channels/message-meta.js";
import { indexAgentMembers } from "./conversations.js";
import { emitChatEvent } from "./events.js";
import { notifyAllSubscribers } from "./preferences.js";

export async function indexConversationAgents(params: {
  nestId: string;
  nodeId: string;
  thread: { id: string; comments: Array<{ id: string; author: string }> };
  authorEmail: string;
}): Promise<void> {
  const commentId = justWritten(params.thread, params.authorEmail);
  if (!commentId) return;
  try {
    const row = (await getDb().get("SELECT client_json FROM annotation_comments WHERE id = ?", [commentId])) as { client_json: string | null } | undefined;
    await indexAgentMembers({
      nestId: params.nestId,
      nodeId: params.nodeId,
      threadId: params.thread.id,
      commentId,
      authorEmail: params.authorEmail,
      authorHandles: writerHandlesOf(row?.client_json),
    });
  } catch (err) {
    console.error("[chat] conversation agent index failed", params.nestId, params.nodeId, err);
  }
}

export async function afterPostedMessage(params: {
  nestId: string;
  nodeId: string;
  thread: { id: string; comments: Array<{ id: string; author: string }> };
  isReply: boolean;
  authorEmail: string;
  commentId: string | null;
}): Promise<void> {
  const { nestId, nodeId, thread, isReply, authorEmail, commentId } = params;
  try {
    const row = commentId
      ? ((await getDb().get("SELECT client_json FROM annotation_comments WHERE id = ?", [commentId])) as { client_json: string | null } | undefined)
      : undefined;
    const names = (await getDb().get("SELECT name FROM users WHERE LOWER(email) = LOWER(?)", [authorEmail])) as { name: string | null } | undefined;
    emitChatEvent(nestId, {
      type: "message.new",
      conversation: nodeId,
      thread_id: thread.id,
      message_id: commentId,
      reply: isReply,
      author: authorEmail.toLowerCase(),
      author_name: names?.name?.trim() || authorEmail,
      agent: writerHandlesOf(row?.client_json)[0] ?? null,
    });
    await notifyAllSubscribers({ nestId, nodeId, authorEmail, authorClientJson: row?.client_json ?? null });
  } catch (err) {
    console.error("[chat] post hook failed", nestId, nodeId, err);
  }
}
