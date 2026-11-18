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
 * Those outcomes are told only to a caller who may see the nest's roster
 * (`canSeeRoster`: someone on it, or a writer). Commenting is read-tier, so a
 * visitor to a public nest can comment on a published page; answering them
 * "@john reached John Smith" would let anyone enumerate who is on the nest.
 * They get an empty list.
 *
 * Never called for text a model wrote (Hootie, a metacognition agent) or for
 * a server-composed reply (promote): those must not page anyone.
 */
import type { AnnotationThread } from "../annotations/types.js";
import { syncAnnotationsNode } from "../annotations/service.js";
import { canOpenNode, notifyComment } from "../governance/mention-notify.js";
import { indexPostedMessage, justWritten } from "../mentions/mention-index.js";
import { wakeForPostedMessage, type WakeOutcome } from "../stream/agent-wake.js";
import { canSeeRoster, listNestPeople } from "../nests/people-service.js";
import { isChannelNode } from "./channel-node.js";
import { normHandle, resolveBodyMentions } from "./message-meta.js";
import { indexBroadcast } from "./broadcast.js";
// Team chat harness C2 (PO-1197): conversations, the live event, 'all' subscribers.
import { isConversationId } from "../chat/containers.js";
import { afterPostedMessage, indexConversationAgents } from "../chat/hooks.js";
import { recordMessageLinks } from "../memory/links.js";
import { onPostedMessage as watchPostedMessage } from "../memory/watcher.js";

export type MentionOutcome =
  | { name: string; kind: "person"; display_name: string; notified: boolean }
  | { name: string; kind: "agent"; wake: WakeOutcome }
  /** `@channel` / `@here` in a channel: how many other members it reached (PO-1196). */
  | { name: string; kind: "everyone"; reached: number }
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
  /** The poster's user id: decides whether they may be told who was reached. */
  authorUserId: string;
  baseUrl?: string;
}): Promise<PostedMessage> {
  const { nestId, nodeId, thread, isReply, body, authorEmail, baseUrl } = params;
  // A conversation (C2) is a channel-like container: only mentions notify.
  const conversation = isConversationId(nodeId);
  const channel = conversation || (await isChannelNode(nestId, nodeId));
  await notifyComment({ nestId, nodeId, body, actorEmail: authorEmail, baseUrl, channel, ...(isReply ? { thread } : {}) });
  await indexPostedMessage({ nestId, nodeId, thread, body, authorEmail });
  const commentId = justWritten(thread, authorEmail);
  // `@channel` / `@here`: a row for every other member (channels only; after
  // the named rows, which it skips). Never wakes anyone.
  const reached =
    channel && commentId ? await indexBroadcast({ nestId, nodeId, threadId: thread.id, commentId, body, authorEmail }) : 0;
  // An agent member of a conversation is addressed by every message in it (C2).
  if (conversation) await indexConversationAgents({ nestId, nodeId, thread, authorEmail });
  // Reads the index rows just written, so it runs after them.
  const wakes = await wakeForPostedMessage({ nestId, nodeId, thread, authorEmail });
  // A conversation has no node to project into.
  if (!conversation) await syncAnnotationsNode(nestId, nodeId, authorEmail);

  const posted: PostedMessage = { node_id: nodeId, thread_id: thread.id, comment_id: commentId, mentions: [] };
  // The live event and the 'all' subscribers (C2); never for a document thread.
  if (channel) await afterPostedMessage({ nestId, nodeId, thread, isReply, authorEmail, commentId });
  // Memory snowball (team chat C6, PO-1199): the nodes this message names
  // become thread→node relations, and a watched channel's agent sees it.
  // Both best effort — never the poster's problem.
  await recordMessageLinks({ nestId, nodeId, threadId: thread.id, messageId: commentId, body, authorEmail, authorUserId: params.authorUserId }).catch((err) =>
    console.warn("[memory] links not recorded", nestId, thread.id, err?.message ?? err),
  );
  await watchPostedMessage({ nestId, nodeId, threadId: thread.id, body }).catch(() => {});
  // "@hootie …" in a channel (C7, PO-1198): the nest answers in the thread, as
  // this person, in the background. Channels only — DMs to Hootie are deferred
  // (C2 conversations). The answer it posts never comes back through here.
  if (channel && !conversation && commentId) {
    const { triggerHootieForMessage } = await import("../agents/ask-nest.js");
    triggerHootieForMessage({ nestId, nodeId, threadId: thread.id, commentId, body, authorEmail, authorUserId: params.authorUserId, baseUrl });
  }
  const mayKnow = await canSeeRoster(nestId, params.authorUserId, authorEmail, await listNestPeople(nestId)).catch(() => false);
  if (!mayKnow) return posted;

  const author = authorEmail.toLowerCase();
  const mentions = posted.mentions;
  for (const m of (await resolveBodyMentions(nestId, [body], { broadcast: channel }).catch(() => [[]]))[0] ?? []) {
    if (m.everyone) {
      mentions.push({ name: m.name, kind: "everyone", reached });
      continue;
    }
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
  return posted;
}

/** The outcomes in one line, for a tool's text result; "" when none. */
export function mentionsLine(mentions: MentionOutcome[]): string {
  if (mentions.length === 0) return "";
  const parts = mentions.map((m) => {
    if (m.kind === "person") return `@${m.name} reached ${m.display_name}${m.notified ? "" : " (not notified: it is you, or they can't open this)"}`;
    if (m.kind === "everyone") return `@${m.name} reached ${m.reached} other ${m.reached === 1 ? "person" : "people"} added to the nest`;
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
