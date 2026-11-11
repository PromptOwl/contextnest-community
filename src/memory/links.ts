/**
 * Thread ↔ node relations, automatically (team chat C6, PO-1199).
 *
 * When a message names a node — a `[[wikilink]]`, a document link, a node
 * URL: exactly the links artifact cards resolve (stream/artifact-cards.ts)
 * — the thread is related to the node with a `discussed-in` edge (kind
 * `mentioned`, nodes/relations.ts). Promote, remember, correct and the
 * channel watcher record their own kinds where they write.
 *
 * Bounded (the card extractor's 20 links per message), deduped (the edge
 * store is idempotent per thread, node and kind), same nest only (a link
 * into another nest has nowhere to live), and never a node the AUTHOR can't
 * open: cards are resolved for the author, so a link they can't read is an
 * unresolved marker and records nothing. Read back per reader: a node they
 * can't open is never named (filterAccessible, the listing gate).
 */
import { getDb } from "../db/client.js";
import { filterAccessible } from "../governance/access-guard.js";
import { ensureNodeIndex } from "../nodes/node-index.js";
import { findThreadRelations, recordThreadRelation, type ThreadRelationKind } from "../nodes/relations.js";
import { extractCardLinks, resolveCards } from "../stream/artifact-cards.js";

export interface RelatedNode {
  node_id: string;
  title: string;
  type: string;
  kind: ThreadRelationKind;
  memory_kind: string | null;
  proposer: string | null;
  created_at: string;
}

/** Most related nodes listed per thread. */
export const MAX_RELATED_PER_THREAD = 50;

/** Record the nodes a just-posted message names. Best effort: a failure is logged, never the poster's problem. */
export async function recordMessageLinks(params: {
  nestId: string;
  nodeId: string;
  threadId: string;
  /** The message that named them (kept for the caller; the relation is per thread). */
  messageId: string | null;
  body: string;
  authorEmail: string;
  authorUserId: string;
}): Promise<number> {
  const links = extractCardLinks(params.body);
  if (links.length === 0) return 0;
  const cards = await resolveCards(
    { nestId: params.nestId, userId: params.authorUserId, userEmail: params.authorEmail, crossNest: false },
    links,
  );
  let recorded = 0;
  const seen = new Set<string>();
  for (const c of cards) {
    if (!c.resolved || c.nest_id !== params.nestId || c.node_id === params.nodeId || seen.has(c.node_id)) continue;
    seen.add(c.node_id);
    try {
      const { created } = await recordThreadRelation({
        nestId: params.nestId,
        nodeId: c.node_id,
        hostNodeId: params.nodeId,
        createdBy: params.authorEmail,
        // Per thread, not per message: a node named twice in one thread is one relation.
        meta: { thread_id: params.threadId, message_id: null, kind: "mentioned", memory_kind: null, proposer: null },
      });
      if (created) recorded++;
    } catch (err) {
      console.warn("[memory] link not recorded", params.nestId, c.node_id, (err as Error)?.message ?? err);
    }
  }
  return recorded;
}

/** Title and type per node id from the node index (no vault reads). */
export async function indexedTitles(nestId: string, ids: string[]): Promise<Map<string, { title: string; type: string; status: string }>> {
  const out = new Map<string, { title: string; type: string; status: string }>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  await ensureNodeIndex(nestId);
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = (await getDb().all(
      `SELECT node_id, title, type, status FROM node_index WHERE nest_id = ? AND node_id IN (${chunk.map(() => "?").join(",")})`,
      [nestId, ...chunk],
    )) as Array<{ node_id: string; title: string; type: string; status: string }>;
    for (const r of rows) out.set(r.node_id, { title: r.title || r.node_id, type: r.type || "document", status: r.status || "draft" });
  }
  return out;
}

/**
 * The nodes each of these threads touched, for THIS reader: one they can't
 * open is left out, like an artifact card they can't read. One edge per
 * (node, kind); newest first; at most MAX_RELATED_PER_THREAD per thread.
 */
export async function relatedNodesForThreads(
  caller: { nestId: string; userId: string; userEmail: string },
  hostNodeId: string,
  threadIds: string[],
): Promise<Map<string, RelatedNode[]>> {
  const out = new Map<string, RelatedNode[]>();
  if (threadIds.length === 0) return out;
  const rows = await findThreadRelations(caller.nestId, { hostNodeIds: [hostNodeId], threadIds });
  if (rows.length === 0) return out;
  const ids = [...new Set(rows.map((r) => r.node_id))];
  const readable = new Set((await filterAccessible(caller.nestId, caller.userId, caller.userEmail, ids.map((id) => ({ id })))).map((n) => n.id));
  const meta = await indexedTitles(caller.nestId, ids);
  const seen = new Set<string>();
  for (const r of rows) {
    if (!readable.has(r.node_id)) continue;
    const m = meta.get(r.node_id);
    if (!m) continue; // gone; its purge drops the edge
    const key = `${r.thread_id}\u0000${r.node_id}\u0000${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = out.get(r.thread_id) ?? [];
    if (list.length >= MAX_RELATED_PER_THREAD) continue;
    list.push({ node_id: r.node_id, title: m.title, type: m.type, kind: r.kind, memory_kind: r.memory_kind, proposer: r.proposer, created_at: r.created_at });
    out.set(r.thread_id, list);
  }
  return out;
}

/** One line for an agent's text result; "" when none. */
export function relatedNodesText(list: RelatedNode[] | undefined): string {
  if (!list?.length) return "";
  return `\n\nRelated nodes: ${list.map((n) => `${n.kind} "${n.title}" (${n.node_id})`).join("; ")}.`;
}
