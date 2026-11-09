/**
 * What happens after a person's message lands in a comment thread — a channel
 * post or a document comment — and what the caller is told about it.
 *
 * ONE function for the REST thread routes and MCP `context_comment`, so the
 * two can't drift (they did: the fan-out used to be copied into each):
 *
 *   1. notify the people it names (and, on a document, the thread's
 *      participants and the document's followers — not in a channel, where
 *      only a mention notifies);
 *   2. index who it tags, for My Work's Mentions;
 *   3. wake the tagged agents that have a webhook target;
 *   4. re-project an artifact's annotations node;
 *
 * and then says, per `@name`, what it reached (PO-1190, AC-AX-04): a person
 * (and whether they were notified), a known agent (and whether a wake-up went
 * out), or nobody. A first name that matches no one used to miss silently.
 *
 * Never called for text a model wrote (Hootie, a metacognition agent) or for
 * a server-composed reply (promote): those must not page anyone.
 */
import type { AnnotationThread } from "../annotations/types.js";
import { syncAnnotationsNode } from "../annotations/service.js";
import { canOpenNode, notifyComment } from "../governance/mention-notify.js";
import { indexPostedMessage, justWritten } from "../mentions/mention-index.js";
import { wakeForPostedMessage, type WakeOutcome } from "../stream/agent-wake.js";
import { isChannelNode } from "./channel-node.js";
import { normHandle, resolveBodyMentions } from "./message-meta.js";

export type MentionOutcome =
  | { name: string; kind: "person"; display_name: string; notified: boolean }
  | { name: string; kind: "agent"; wake: WakeOutcome }
  | { name: string; kind: "nobody" };

export interface PostedMessage {
  node_id: string;
  thread_id: string;
  /** The message just written (null only if it can't be told apart). */
  comment_id: string | null;
  mentions: MentionOutcome[];
}

export async function fanOutPostedMessage(params: {
  nestId: string;
  nodeId: string;
  /** The thread AFTER the message was added. */
  thread: AnnotationThread;
  /** True for a reply, false for the message that opened the thread. */
  isReply: boolean;
  body: string;
  authorEmail: string;
  baseUrl?: string;
}): Promise<PostedMessage> {
  const { nestId, nodeId, thread, isReply, body, authorEmail, baseUrl } = params;
  const channel = await isChannelNode(nestId, nodeId);
  await notifyComment({ nestId, nodeId, body, actorEmail: authorEmail, baseUrl, channel, ...(isReply ? { thread } : {}) });
  await indexPostedMessage({ nestId, nodeId, thread, body, authorEmail });
  // Reads the index rows just written, so it runs after them.
  const wakes = await wakeForPostedMessage({ nestId, nodeId, thread, authorEmail });
  await syncAnnotationsNode(nestId, nodeId, authorEmail);

  const author = authorEmail.toLowerCase();
  const mentions: MentionOutcome[] = [];
  for (const m of (await resolveBodyMentions(nestId, [body]).catch(() => [[]]))[0] ?? []) {
    if (m.person) {
      const p = m.person;
      const notified =
        !!p.userId && p.email.toLowerCase() !== author && (await canOpenNode(nestId, nodeId, p.userId, p.email).catch(() => false));
      mentions.push({ name: m.name, kind: "person", display_name: p.name?.trim() || p.email, notified });
      continue;
    }
    const wake = wakes.get(normHandle(m.name));
    if (m.agent || wake === "sent") {
      mentions.push({ name: m.name, kind: "agent", wake: wake ?? (m.agent?.wakeable ? "skipped" : "no_webhook") });
    } else {
      mentions.push({ name: m.name, kind: "nobody" });
    }
  }
  return { node_id: nodeId, thread_id: thread.id, comment_id: justWritten(thread, authorEmail), mentions };
}

/** The outcomes in one line, for a tool's text result; "" when none. */
export function mentionsLine(mentions: MentionOutcome[]): string {
  if (mentions.length === 0) return "";
  const parts = mentions.map((m) => {
    if (m.kind === "person") return `@${m.name} reached ${m.display_name}${m.notified ? "" : " (not notified: it is you, or they can't open this)"}`;
    if (m.kind === "agent") {
      return m.wake === "sent"
        ? `@${m.name} is an agent, wake-up sent`
        : m.wake === "no_webhook"
          ? `@${m.name} is an agent with no webhook (it finds this in its context_my_work)`
          : `@${m.name} is an agent, no wake-up sent this time`;
    }
    return `@${m.name} matched nobody`;
  });
  return `Mentions: ${parts.join("; ")}.`;
}
