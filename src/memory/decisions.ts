/**
 * The decision ledger (team chat C6, PO-1199): a view over existing nodes,
 * not a table. A decision is a node that carries `source_thread` (promote
 * and remember both set it) and the `#decision` tag (both give decisions
 * that tag); who decided and when come from the `discussed-in` edge that
 * promote / remember recorded (the person the write is attributed to, and
 * the proposer label), or, for promotions older than that edge, from the
 * node's first version. There is no `decisions` board or view in the
 * product to reuse: this is the first one.
 *
 * Members only (NotFound otherwise, like agent-handles), never a node the
 * caller can't read (filterAccessible), and only threads on a node the
 * caller can open are named as the source.
 */
import { getDb } from "../db/client.js";
import { filterAccessible } from "../governance/access-guard.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { getDisplayStatuses, type DisplayStatus } from "../governance/version-service.js";
import { findThreadRelations } from "../nodes/relations.js";
import { normalizeTag } from "../governance/tag-index-service.js";
import { isNestMember } from "../channels/channel-service.js";
import { channelNameOf } from "../channels/channel-node.js";
import { displayNames } from "../channels/message-meta.js";
import { NotFoundError } from "../shared/errors.js";
import { nodeUrl } from "./format.js";

export interface Decision {
  node_id: string;
  title: string;
  status: DisplayStatus;
  /** promoted | remembered */
  kind: "promoted" | "remembered";
  decided_by: string;
  decided_by_name: string;
  proposer: string;
  decided_at: string;
  source_thread: { node_id: string; thread_id: string; channel: string | null } | null;
  url: string;
}

export interface DecisionLedger {
  decisions: Decision[];
  pagination: { total: number; limit: number; offset: number; has_more: boolean };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function listDecisions(
  caller: { nestId: string; userId: string; userEmail: string },
  input: { limit?: unknown; offset?: unknown } = {},
): Promise<DecisionLedger> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Not found");
  const limit = Math.min(Math.max(Math.floor(Number(input.limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Math.floor(Number(input.offset)) || 0, 0);
  const { nestId } = caller;
  const db = getDb();

  const rows = (await db.all(
    `SELECT node_id, frontmatter_json FROM node_index WHERE nest_id = ? AND frontmatter_json LIKE '%"source_thread"%'`,
    [nestId],
  )) as Array<{ node_id: string; frontmatter_json: string }>;
  const candidates: Array<{ node_id: string; title: string; source: { node_id: string; thread_id: string } }> = [];
  for (const r of rows) {
    let fm: any;
    try {
      fm = JSON.parse(r.frontmatter_json);
    } catch {
      continue;
    }
    const st = fm?.metadata?.source_thread;
    const tags: string[] = Array.isArray(fm?.tags) ? fm.tags.map((t: unknown) => normalizeTag(String(t))) : [];
    if (!st || typeof st.node_id !== "string" || typeof st.thread_id !== "string" || !tags.includes("decision")) continue;
    candidates.push({ node_id: r.node_id, title: String(fm.title ?? r.node_id), source: { node_id: st.node_id, thread_id: st.thread_id } });
  }
  if (candidates.length === 0) return { decisions: [], pagination: { total: 0, limit, offset, has_more: false } };

  const ids = candidates.map((c) => c.node_id);
  const readable = new Set((await filterAccessible(nestId, caller.userId, caller.userEmail, ids.map((id) => ({ id })))).map((n) => n.id));
  const edges = await findThreadRelations(nestId, { nodeIds: ids });
  const byNode = new Map<string, (typeof edges)[number]>();
  for (const e of edges) {
    if ((e.kind === "promoted" || e.kind === "remembered") && !byNode.has(e.node_id)) byNode.set(e.node_id, e);
  }
  const statuses = await getDisplayStatuses(nestId);
  const hostOpen = new Map<string, boolean>();
  const all: Decision[] = [];
  for (const c of candidates) {
    if (!readable.has(c.node_id)) continue;
    const e = byNode.get(c.node_id);
    let by = e?.created_by ?? "";
    let at = e?.created_at ?? "";
    if (!e) {
      const v1 = (await db.get("SELECT author, created_at FROM node_versions WHERE nest_id = ? AND node_id = ? ORDER BY version ASC LIMIT 1", [nestId, c.node_id])) as
        | { author: string; created_at: string }
        | undefined;
      by = v1?.author ?? "";
      at = v1?.created_at ?? "";
    }
    let open = hostOpen.get(c.source.node_id);
    if (open === undefined) {
      open = await canOpenNode(nestId, c.source.node_id, caller.userId, caller.userEmail).catch(() => false);
      hostOpen.set(c.source.node_id, open);
    }
    all.push({
      node_id: c.node_id,
      title: c.title,
      status: statuses.get(c.node_id) ?? "draft",
      kind: e?.kind === "remembered" ? "remembered" : "promoted",
      decided_by: by,
      decided_by_name: by,
      proposer: e?.proposer ?? by,
      decided_at: at,
      source_thread: open ? { ...c.source, channel: channelNameOf(c.source.node_id) } : null,
      url: nodeUrl(nestId, c.node_id),
    });
  }
  all.sort((a, b) => (a.decided_at < b.decided_at ? 1 : a.decided_at > b.decided_at ? -1 : a.node_id.localeCompare(b.node_id)));
  const page = all.slice(offset, offset + limit);
  const names = await displayNames(page.map((d) => d.decided_by));
  for (const d of page) {
    d.decided_by_name = names.get(d.decided_by.toLowerCase()) ?? d.decided_by;
    if (d.proposer === d.decided_by) d.proposer = d.decided_by_name;
  }
  return { decisions: page, pagination: { total: all.length, limit, offset, has_more: offset + page.length < all.length } };
}

export function decisionsText(l: DecisionLedger): string {
  if (l.decisions.length === 0) return "No decisions on record yet. Promote a thread with kind decision (context_promote_thread), or remember a message as one (context_remember { kind: \"decision\" }).";
  const lines = l.decisions.map(
    (d) =>
      `- "${d.title}" (${d.node_id}) — ${d.status}; decided by ${d.proposer}, ${d.decided_at}${
        d.source_thread ? `; from ${d.source_thread.channel ? `#${d.source_thread.channel}` : d.source_thread.node_id} thread ${d.source_thread.thread_id}` : ""
      }`,
  );
  const { total, offset, has_more } = l.pagination;
  return `# Decisions (${l.decisions.length} of ${total}, newest first${offset ? `, from ${offset}` : ""})\n\n${lines.join("\n")}${has_more ? `\n\nMore: pass offset ${offset + l.decisions.length}.` : ""}`;
}
