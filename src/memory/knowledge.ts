/**
 * What a channel taught the nest (team chat C6, PO-1199): a query, not a
 * store. The nodes produced from a channel's threads — promoted, remembered,
 * corrected, or proposed by the channel watcher — come from the
 * `discussed-in` edges on the channel node (nodes/relations.ts), joined
 * with nodes that carry `source_thread` on this channel (promotions made
 * before the edge existed). Status is the governance display status
 * (version-service), open proposals the pending review requests.
 *
 * Members only, through `getReadableChannel` (NotFound otherwise, no
 * existence oracle), and never a node the caller can't read
 * (filterAccessible, the listing gate).
 */
import { getDb } from "../db/client.js";
import { filterAccessible } from "../governance/access-guard.js";
import { getDisplayStatuses, type DisplayStatus } from "../governance/version-service.js";
import { findThreadRelations, type ThreadRelationKind } from "../nodes/relations.js";
import { getReadableChannel, type ChannelView } from "../channels/channel-service.js";
import { displayNames } from "../channels/message-meta.js";
import { nodeUrl } from "./format.js";
import { indexedTitles } from "./links.js";

const KNOWLEDGE_KINDS: ReadonlySet<ThreadRelationKind> = new Set(["promoted", "remembered", "corrected", "proposed"]);

export interface KnowledgeNode {
  node_id: string;
  title: string;
  type: string;
  /** draft | pending_review | approved | published | rejected */
  status: DisplayStatus;
  kind: ThreadRelationKind;
  memory_kind: string | null;
  thread_id: string;
  message_id: string | null;
  /** The login the write is attributed to. */
  by: string;
  by_name: string;
  /** Who proposed it: a person, "<agent>, on behalf of <person>", or the watcher's persona. */
  proposer: string;
  at: string;
  url: string;
}

export interface OpenProposal {
  review_id: string;
  node_id: string;
  title: string;
  requested_by: string;
  requested_at: string;
  note: string | null;
}

export interface ChannelKnowledge {
  channel: ChannelView;
  nodes: KnowledgeNode[];
  open_proposals: OpenProposal[];
  counts: { total: number } & Partial<Record<DisplayStatus, number>>;
}

interface Produced {
  node_id: string;
  kind: ThreadRelationKind;
  memory_kind: string | null;
  thread_id: string;
  message_id: string | null;
  by: string;
  proposer: string | null;
  at: string;
}

/** Everything produced from these channel nodes: edges first, then legacy `source_thread` promotions not covered by one. */
async function producedBy(nestId: string, channelIds: string[]): Promise<Map<string, Produced[]>> {
  const out = new Map<string, Produced[]>();
  if (channelIds.length === 0) return out;
  const push = (host: string, p: Produced) => {
    const list = out.get(host) ?? [];
    list.push(p);
    out.set(host, list);
  };
  const seen = new Set<string>();
  for (const r of await findThreadRelations(nestId, { hostNodeIds: channelIds })) {
    if (!KNOWLEDGE_KINDS.has(r.kind)) continue;
    seen.add(`${r.host_node_id}\u0000${r.node_id}`);
    push(r.host_node_id, { node_id: r.node_id, kind: r.kind, memory_kind: r.memory_kind, thread_id: r.thread_id, message_id: r.message_id, by: r.created_by, proposer: r.proposer, at: r.created_at });
  }
  const wanted = new Set(channelIds);
  const rows = (await getDb().all(
    `SELECT node_id, type, frontmatter_json FROM node_index WHERE nest_id = ? AND frontmatter_json LIKE '%"source_thread"%' ORDER BY node_id`,
    [nestId],
  )) as Array<{ node_id: string; type: string; frontmatter_json: string }>;
  for (const r of rows) {
    let fm: any;
    try {
      fm = JSON.parse(r.frontmatter_json);
    } catch {
      continue;
    }
    const st = fm?.metadata?.source_thread;
    if (!st || typeof st.node_id !== "string" || typeof st.thread_id !== "string" || !wanted.has(st.node_id)) continue;
    if (seen.has(`${st.node_id}\u0000${r.node_id}`)) continue;
    const v1 = (await getDb().get(
      "SELECT author, created_at FROM node_versions WHERE nest_id = ? AND node_id = ? ORDER BY version ASC LIMIT 1",
      [nestId, r.node_id],
    )) as { author: string; created_at: string } | undefined;
    push(st.node_id, {
      node_id: r.node_id,
      kind: "promoted",
      memory_kind: r.type === "task" ? "task" : "decision",
      thread_id: st.thread_id,
      message_id: null,
      by: v1?.author ?? String(fm.author ?? ""),
      proposer: null,
      at: v1?.created_at ?? String(fm.created_at ?? ""),
    });
  }
  return out;
}

export async function channelKnowledge(caller: { nestId: string; userId: string; userEmail: string }, rawName: unknown): Promise<ChannelKnowledge> {
  const { node, view } = await getReadableChannel(caller, rawName);
  const produced = (await producedBy(caller.nestId, [node.id])).get(node.id) ?? [];
  const ids = [...new Set(produced.map((p) => p.node_id))];
  const readable = new Set((await filterAccessible(caller.nestId, caller.userId, caller.userEmail, ids.map((id) => ({ id })))).map((n) => n.id));
  const [meta, statuses, names] = await Promise.all([
    indexedTitles(caller.nestId, ids),
    getDisplayStatuses(caller.nestId),
    displayNames(produced.map((p) => p.by)),
  ]);
  const nodes: KnowledgeNode[] = [];
  const counts: ChannelKnowledge["counts"] = { total: 0 };
  for (const p of produced.sort((a, b) => (a.at < b.at ? 1 : -1))) {
    if (!readable.has(p.node_id)) continue;
    const m = meta.get(p.node_id);
    if (!m) continue;
    const status = statuses.get(p.node_id) ?? "draft";
    nodes.push({
      node_id: p.node_id,
      title: m.title,
      type: m.type,
      status,
      kind: p.kind,
      memory_kind: p.memory_kind,
      thread_id: p.thread_id,
      message_id: p.message_id,
      by: p.by,
      by_name: names.get(p.by.toLowerCase()) ?? p.by,
      proposer: p.proposer ?? names.get(p.by.toLowerCase()) ?? p.by,
      at: p.at,
      url: nodeUrl(caller.nestId, p.node_id),
    });
  }
  const distinct = new Set(nodes.map((n) => n.node_id));
  counts.total = distinct.size;
  for (const id of distinct) {
    const s = statuses.get(id) ?? "draft";
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const open_proposals: OpenProposal[] = [];
  if (distinct.size) {
    const list = [...distinct];
    const rows = (await getDb().all(
      `SELECT id, node_id, requested_by, requested_at, request_note FROM review_requests
        WHERE nest_id = ? AND status = 'pending' AND node_id IN (${list.map(() => "?").join(",")})
        ORDER BY requested_at DESC`,
      [caller.nestId, ...list],
    )) as Array<{ id: string; node_id: string; requested_by: string; requested_at: string; request_note: string | null }>;
    for (const r of rows) {
      open_proposals.push({ review_id: r.id, node_id: r.node_id, title: meta.get(r.node_id)?.title ?? r.node_id, requested_by: r.requested_by, requested_at: r.requested_at, note: r.request_note });
    }
  }
  return { channel: view, nodes, open_proposals, counts };
}

/** Readable produced-node counts per channel, for the channel list (`knowledge_count`). */
export async function knowledgeCounts(caller: { nestId: string; userId: string; userEmail: string }, channelIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const produced = await producedBy(caller.nestId, channelIds);
  const all = [...new Set([...produced.values()].flat().map((p) => p.node_id))];
  if (all.length === 0) return out;
  const readable = new Set((await filterAccessible(caller.nestId, caller.userId, caller.userEmail, all.map((id) => ({ id })))).map((n) => n.id));
  for (const [host, list] of produced) {
    out.set(host, new Set(list.filter((p) => readable.has(p.node_id)).map((p) => p.node_id)).size);
  }
  return out;
}

export function knowledgeText(k: ChannelKnowledge): string {
  const head = `# What ${k.channel.title} taught the nest`;
  if (k.nodes.length === 0) return `${head}\n\nNothing yet. Promote a thread (context_promote_thread), remember a message (context_remember) or correct a node from a thread (context_correct).`;
  const lines = k.nodes.map((n) => `- ${n.kind}${n.memory_kind ? ` (${n.memory_kind})` : ""}: "${n.title}" (${n.node_id}) — ${n.status}, by ${n.proposer}, ${n.at}`);
  const open = k.open_proposals.length
    ? `\n\nOpen proposals (${k.open_proposals.length}):\n${k.open_proposals.map((o) => `- "${o.title}" (${o.node_id}) requested by ${o.requested_by}${o.note ? `: ${o.note}` : ""}`).join("\n")}`
    : "";
  return `${head}\n\n${k.counts.total} node(s):\n${lines.join("\n")}${open}`;
}
