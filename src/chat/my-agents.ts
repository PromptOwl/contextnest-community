/**
 * My agents (One chat 8, PO-1539): what the agents that write under my login
 * have said, across every nest I can read — `GET /me/chat/agents`.
 *
 * Reads the message store there already is: comments whose author is the
 * caller and whose declared `client` names an agent. Nothing here decides
 * what is readable: a conversation or private channel answers through its own
 * membership verdict and every other node through `canOpenNode`, so losing a
 * nest, a channel or a document takes its rows away. A handle someone ELSE
 * declares is theirs: rows are matched on the author, never on the name.
 */
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { listVisibleNests } from "../nests/service.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { channelNameOf, isChannelId } from "../channels/channel-node.js";
import { isNestMember } from "../channels/channel-service.js";
import { writerHandlesOf } from "../channels/message-meta.js";
import { containerReadVerdict, isConversationId } from "./containers.js";
import { nestChatEnabled } from "./settings.js";

/** Newest messages of mine considered, and threads listed. */
const SCAN = 500;
const MAX_THREADS = 50;
const EXCERPT = 280;

export interface MyAgentThread {
  nest_id: string;
  nest_name: string;
  node_id: string;
  /** The channel's name, for a channel. */
  channel: string | null;
  kind: "channel" | "conversation" | "document";
  thread_id: string;
  /** My agents' handles in this thread, newest speaker first. */
  agents: string[];
  excerpt: string;
  at: string;
  /** Someone else (a person or another agent) spoke after my agent. */
  answered: boolean;
}

export interface MyAgents {
  agents: Array<{ handle: string; nests: string[]; last_at: string; threads: number; answered: number }>;
  threads: MyAgentThread[];
}

export async function myAgents(params: { userId: string; email: string }): Promise<MyAgents> {
  const out: MyAgents = { agents: [], threads: [] };
  if (!config.TEAM_CHAT_ENABLED) return out;
  const { userId } = params;
  const email = params.email.toLowerCase();
  const nests = new Map((await listVisibleNests(userId)).map((n) => [n.id, n.name ?? n.id]));
  if (nests.size === 0) return out;
  const ids = [...nests.keys()];
  const rows = (await getDb().all(
    `SELECT c.thread_id, c.body, c.created_at, c.client_json, t.nest_id, t.node_id
       FROM annotation_comments c JOIN annotation_threads t ON t.id = c.thread_id
      WHERE LOWER(c.author) = ? AND c.client_json IS NOT NULL AND c.deleted_at IS NULL
        AND t.nest_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY c.created_at DESC LIMIT ${SCAN}`,
    [email, ...ids],
  )) as Array<{ thread_id: string; body: string; created_at: string; client_json: string; nest_id: string; node_id: string }>;

  const readable = new Map<string, Promise<boolean>>();
  const chatHere = new Map<string, Promise<boolean>>();
  const canRead = (nestId: string, nodeId: string) => {
    const key = `${nestId}\u0000${nodeId}`;
    let p = readable.get(key);
    if (!p) {
      p = (async () => {
        if (isChannelId(nodeId) || isConversationId(nodeId)) {
          let on = chatHere.get(nestId);
          if (!on) {
            on = (async () => (await nestChatEnabled(nestId)) && (await isNestMember(nestId, userId)))();
            chatHere.set(nestId, on);
          }
          if (!(await on)) return false;
          const verdict = await containerReadVerdict(nestId, nodeId, userId);
          if (verdict !== null) return verdict;
        }
        return canOpenNode(nestId, nodeId, userId, email);
      })().catch(() => false);
      readable.set(key, p);
    }
    return p;
  };

  const threads = new Map<string, MyAgentThread>();
  for (const r of rows) {
    const handles = writerHandlesOf(r.client_json);
    if (handles.length === 0) continue;
    const seen = threads.get(r.thread_id);
    if (seen) {
      for (const h of handles) if (!seen.agents.includes(h)) seen.agents.push(h);
      continue;
    }
    if (threads.size >= MAX_THREADS || !(await canRead(r.nest_id, r.node_id))) continue;
    threads.set(r.thread_id, {
      nest_id: r.nest_id,
      nest_name: nests.get(r.nest_id)!,
      node_id: r.node_id,
      channel: isChannelId(r.node_id) ? channelNameOf(r.node_id) : null,
      kind: isConversationId(r.node_id) ? "conversation" : isChannelId(r.node_id) ? "channel" : "document",
      thread_id: r.thread_id,
      agents: [...handles],
      excerpt: r.body.length > EXCERPT ? `${r.body.slice(0, EXCERPT)}…` : r.body,
      at: r.created_at,
      answered: false,
    });
  }
  const list = [...threads.values()];
  if (list.length > 0) {
    // The last message of each thread: answered when it is not my agent's.
    const last = (await getDb().all(
      `SELECT c.thread_id, c.author, c.client_json, c.created_at FROM annotation_comments c
        WHERE c.deleted_at IS NULL AND c.thread_id IN (${list.map(() => "?").join(", ")})
        ORDER BY c.created_at ASC`,
      list.map((t) => t.thread_id),
    )) as Array<{ thread_id: string; author: string; client_json: string | null; created_at: string }>;
    for (const c of last) {
      const t = threads.get(c.thread_id);
      if (t) t.answered = !(c.author.toLowerCase() === email && writerHandlesOf(c.client_json).length > 0);
    }
  }
  out.threads = list;
  const byHandle = new Map<string, MyAgents["agents"][number]>();
  for (const t of list) {
    for (const h of t.agents) {
      const a = byHandle.get(h) ?? { handle: h, nests: [], last_at: t.at, threads: 0, answered: 0 };
      if (!a.nests.includes(t.nest_name)) a.nests.push(t.nest_name);
      a.threads += 1;
      if (t.answered) a.answered += 1;
      byHandle.set(h, a);
    }
  }
  out.agents = [...byHandle.values()];
  return out;
}
