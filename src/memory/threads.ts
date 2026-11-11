/**
 * Memory snowball (team chat C6, PO-1199) — reading a thread for the
 * remember / correct actions, with the same answer for "no such thread",
 * "another nest's thread" and "a node the caller can't open": NotFound, so
 * a thread id is no oracle (the rule promote set, stream/promote.ts).
 */
import { getDb } from "../db/client.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { canCreateInNest } from "../governance/stewardship-service.js";
import { resolveNestAccess } from "../shared/access.js";
import { ForbiddenError, NotFoundError } from "../shared/errors.js";
import { config } from "../config.js";
import { channelPostRefusal } from "../channels/channel-service.js";
import { ConflictError } from "../shared/errors.js";
import type { SourceMessage } from "./format.js";

export interface MemoryCaller {
  nestId: string;
  userId: string;
  userEmail: string;
}

export interface ThreadRow {
  id: string;
  node_id: string;
  status: "open" | "resolved";
}

/** The one line a read-only member is told (AC-C6-04). */
export const ASK_A_WRITER =
  "This needs write access to the nest. Ask a writer to do it, or @mention one in the thread so they can.";

/** The thread, if it is in this nest and the caller can open its node. */
export async function readableThread(caller: MemoryCaller, rawThreadId: unknown): Promise<ThreadRow> {
  const threadId = typeof rawThreadId === "string" ? rawThreadId.trim() : "";
  const row = threadId
    ? ((await getDb().get("SELECT id, node_id, status FROM annotation_threads WHERE id = ? AND nest_id = ?", [threadId, caller.nestId])) as
        | ThreadRow
        | undefined)
    : undefined;
  if (!row || !(await canOpenNode(caller.nestId, row.node_id, caller.userId, caller.userEmail))) {
    throw new NotFoundError("Thread not found");
  }
  return row;
}

/** Every message of a thread, oldest first. */
export async function threadMessages(threadId: string): Promise<SourceMessage[]> {
  return (await getDb().all(
    `SELECT id, author, body, created_at, client_json FROM annotation_comments
      WHERE thread_id = ? ORDER BY created_at ASC, id ASC`,
    [threadId],
  )) as SourceMessage[];
}

/** One message of the thread, or NotFound (a message id from another thread is not here). */
export function messageIn(messages: SourceMessage[], rawMessageId: unknown): SourceMessage {
  const id = typeof rawMessageId === "string" ? rawMessageId.trim() : "";
  const m = id ? messages.find((x) => x.id === id) : undefined;
  if (!m) throw new NotFoundError("Message not found in this thread");
  return m;
}

/**
 * The writes these actions make — a node, a reply in the thread — need a
 * live nest, write access to it (the context_create / POST /nodes rule) and,
 * on a channel, the right to post there. A member without write access is
 * told what to do instead (AC-C6-04).
 */
export async function assertMayWriteFromThread(caller: MemoryCaller, thread: ThreadRow): Promise<void> {
  if (config.AUTH_MODE !== "open" && (await resolveNestAccess(caller.nestId, caller.userId)).archived) {
    throw new ForbiddenError("This nest is archived, so it is read-only.");
  }
  if (!(await canCreateInNest(caller.nestId, caller.userEmail))) throw new ForbiddenError(ASK_A_WRITER);
  const refusal = await channelPostRefusal(caller.nestId, thread.node_id, caller.userId, caller.userEmail);
  if (refusal) throw refusal.status === 409 ? new ConflictError(refusal.error) : new ForbiddenError(refusal.error);
}
