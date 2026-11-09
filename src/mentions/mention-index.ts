/**
 * The @mention index behind My Work's Mentions section (PO-1180, agent team
 * stream S2).
 *
 * Write side — `indexCommentMentions`, called where a person posts a message
 * into a comment thread (a document comment or a channel post: the REST
 * annotation routes and MCP `context_comment`). It records one row per person
 * the message names, resolved exactly as mention-notify resolves them (the
 * nest roster first, then the directory when PEOPLE_SUGGEST_ALL_USERS is on;
 * full email, unique local part or unique display name; the author never).
 * A name that resolves to no account is kept as a bare handle with
 * `mentioned_user_id` NULL — that is how an agent is tagged today, and
 * agent-mentions.ts decides whose it is at read time.
 *
 * Deliberately NOT called for text a model wrote (Hootie's answers, a
 * metacognition agent's comments) or for an anonymous docs-site comment: the
 * same rule mention-notify keeps — a name echoed out of a document must not
 * put work in a colleague's queue in someone else's name.
 *
 * Why an index and not a read-time scan: "open threads that tag me" at read
 * time means parsing the text of every message in every nest the caller can
 * see, on every My Work poll (the badge polls). The index makes it one
 * indexed query on `mentioned_user_id`, with "answered" (a later reply by the
 * caller, or the thread resolved) and access (nests and nodes the caller can
 * read) still decided at read time, so neither can go stale.
 *
 * Read side — `listOpenMentions`.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { listNestPeople, findDirectoryPerson } from "../nests/people-service.js";
import { MAX_MENTION_RECIPIENTS, extractMentions, resolveMention } from "../shared/mentions.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { deserializeClient } from "../shared/client-metadata.js";
import { isChannelId, CHANNEL_TAG } from "../channels/channel-service.js";
import { resolveActorLabel } from "../channels/actor-label.js";
import { normalizeTag } from "../governance/tag-index-service.js";
import { config } from "../config.js";
import { agentHandlesOwnedBy } from "./agent-mentions.js";

/** The longest excerpt a mention item carries (then "…"). */
export const MENTION_EXCERPT_MAX = 280;
/**
 * Most candidate rows one My Work read considers. A person with more open,
 * unanswered mentions than this has a different problem; the bound keeps the
 * read (and the per-node access checks after it) finite.
 */
const MAX_SCAN = 2000;

// ─── Write side ─────────────────────────────────────────────────────────

/**
 * Record who a just-posted thread message @mentions. Best-effort, like every
 * fan-out on the comment path: a failure here never fails the post.
 */
export async function indexCommentMentions(params: {
  nestId: string;
  nodeId: string;
  threadId: string;
  /** The message just written — its id and text. */
  commentId: string;
  body: string;
  authorEmail: string;
}): Promise<number> {
  const { nestId, nodeId, threadId, commentId, body, authorEmail } = params;
  try {
    // extractMentions blanks code spans and fences first (AC-MW-06).
    const names = extractMentions(body || "");
    if (names.length === 0) return 0;
    const roster = await listNestPeople(nestId);
    const author = authorEmail.toLowerCase();
    const people = new Set<string>();
    const handles = new Set<string>();
    const rows: Array<{ userId: string | null; handle: string }> = [];
    for (const name of names) {
      if (rows.length >= MAX_MENTION_RECIPIENTS) break;
      const person = resolveMention(roster, name) ?? (await findDirectoryPerson(name));
      if (person?.userId) {
        if (person.email.toLowerCase() === author || people.has(person.userId)) continue;
        people.add(person.userId);
        rows.push({ userId: person.userId, handle: person.email.toLowerCase() });
        continue;
      }
      // A steward invited by email who never signed up has an email but no
      // account: nobody to put it in front of, and not an agent either.
      if (person) continue;
      const handle = name.trim().toLowerCase();
      if (!handle || handles.has(handle)) continue;
      handles.add(handle);
      rows.push({ userId: null, handle });
    }
    if (rows.length === 0) return 0;

    const db = getDb();
    // The row's time is the message's own, so "replied after the mention"
    // compares like with like (annotation_comments.created_at).
    const msg = (await db.get("SELECT created_at FROM annotation_comments WHERE id = ?", [commentId])) as
      | { created_at: string }
      | undefined;
    if (!msg) return 0;
    for (const r of rows) {
      await db.run(
        `INSERT INTO comment_mentions
           (id, nest_id, node_id, thread_id, comment_id, mentioned_user_id, handle, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), nestId, nodeId, threadId, commentId, r.userId, r.handle, author, msg.created_at],
      );
    }
    return rows.length;
  } catch (err) {
    console.error("[mentions] index failed", nestId, nodeId, threadId, err);
    return 0;
  }
}

/**
 * The message a post or reply just wrote: the thread's newest one by this
 * author (comments load oldest first; matching the author keeps a same-
 * millisecond message from someone else from being taken for it).
 */
export function justWritten(
  thread: { comments: Array<{ id: string; author: string }> },
  authorEmail: string,
): string | null {
  const me = authorEmail.toLowerCase();
  for (let i = thread.comments.length - 1; i >= 0; i--) {
    if (thread.comments[i].author.toLowerCase() === me) return thread.comments[i].id;
  }
  return null;
}

/** Index the message a post or reply just wrote (see indexCommentMentions). */
export async function indexPostedMessage(params: {
  nestId: string;
  nodeId: string;
  thread: { id: string; comments: Array<{ id: string; author: string }> };
  body: string;
  authorEmail: string;
}): Promise<void> {
  const commentId = justWritten(params.thread, params.authorEmail);
  if (!commentId) return;
  await indexCommentMentions({
    nestId: params.nestId,
    nodeId: params.nodeId,
    threadId: params.thread.id,
    commentId,
    body: params.body,
    authorEmail: params.authorEmail,
  });
}

// ─── Read side ──────────────────────────────────────────────────────────

export interface MentionItem {
  type: "mention";
  /** "channel" = a channel post (open it in the channel timeline at
   *  `thread_id`); "document" = a document comment thread. */
  kind: "channel" | "document";
  nest_id: string;
  nest_name: string;
  node_id: string;
  title: string;
  /** The channel's name for a channel post, else null. */
  channel: string | null;
  thread_id: string;
  /** The message that carries the (latest unanswered) mention. */
  comment_id: string;
  excerpt: string;
  /** The person the message is attributed to. */
  author: string;
  /** "<agent>, on behalf of <person>" or the person (resolveActorLabel). */
  author_label: string;
  /** The agent that wrote it on the author's behalf, when one did. */
  agent: string | null;
  /** Null when the caller was named; the agent's handle when one of the
   *  caller's agents was (agent-mentions.ts). */
  for_agent: string | null;
  mentioned_at: string;
}

interface Row {
  nest_id: string;
  node_id: string;
  thread_id: string;
  comment_id: string;
  mentioned_user_id: string | null;
  handle: string;
  author: string;
  created_at: string;
  body: string;
  client_json: string | null;
  title: string | null;
  frontmatter_json: string | null;
}

function excerptOf(body: string): string {
  const flat = String(body ?? "").replace(/\s+/g, " ").trim();
  return flat.length > MENTION_EXCERPT_MAX ? `${flat.slice(0, MENTION_EXCERPT_MAX)}…` : flat;
}

/** "2026-11-08 10:00:00.123" (both dialects' nowMsExpr) → ISO 8601 UTC. */
function toIso(ts: string): string {
  return /^\d{4}-\d\d-\d\d \d/.test(ts) ? `${ts.replace(" ", "T")}Z` : ts;
}

function isChannelRow(r: Row): boolean {
  if (!isChannelId(r.node_id) || !r.frontmatter_json) return false;
  try {
    const tags = JSON.parse(r.frontmatter_json)?.tags;
    return Array.isArray(tags) && tags.some((t) => typeof t === "string" && normalizeTag(t) === CHANNEL_TAG);
  } catch {
    return false;
  }
}

/**
 * Every open thread that @mentions the caller (or an agent the caller owns)
 * and that the caller hasn't answered since, newest mention first, one item
 * per thread — in the given nests only, and only on nodes the caller can open
 * now. Returns the whole filtered list; the caller pages it, so `total` and
 * the badge count exactly what can be shown (AC-MW-03/04).
 */
export async function listOpenMentions(params: {
  userId: string;
  email: string;
  /** Nest id → display name: the nests the caller may see items from. */
  nestNames: Map<string, string>;
}): Promise<MentionItem[]> {
  const { userId, email, nestNames } = params;
  const nestIds = [...nestNames.keys()];
  if (nestIds.length === 0 || !userId) return [];
  const me = email.toLowerCase();
  const handles = await agentHandlesOwnedBy({ userId, email });
  const handleClause = handles.length
    ? ` OR (m.mentioned_user_id IS NULL AND m.handle IN (${handles.map(() => "?").join(", ")}))`
    : "";
  const rows = (await getDb().all(
    `SELECT m.nest_id, m.node_id, m.thread_id, m.comment_id, m.mentioned_user_id, m.handle,
            c.author, m.created_at, c.body, c.client_json, ni.title, ni.frontmatter_json
       FROM comment_mentions m
       JOIN annotation_threads t ON t.id = m.thread_id
       JOIN annotation_comments c ON c.id = m.comment_id
       LEFT JOIN node_index ni ON ni.nest_id = m.nest_id AND ni.node_id = m.node_id
      WHERE m.nest_id IN (${nestIds.map(() => "?").join(", ")})
        AND t.status = 'open'
        AND t.nest_id = m.nest_id
        AND (m.mentioned_user_id = ?${handleClause})
        AND LOWER(m.author) <> ?
        AND NOT EXISTS (
          SELECT 1 FROM annotation_comments r
           WHERE r.thread_id = m.thread_id
             AND LOWER(r.author) = ?
             AND r.id <> m.comment_id
             AND r.created_at >= c.created_at)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${MAX_SCAN}`,
    [...nestIds, userId, ...handles, me, me],
  )) as Row[];

  // One item per thread: the newest unanswered mention in it.
  const perThread = new Map<string, Row>();
  for (const r of rows) if (!perThread.has(r.thread_id)) perThread.set(r.thread_id, r);

  // Access, per distinct node, at read time — losing read on a nest or a
  // document takes its mentions (and their count) away at once.
  const allowed = new Map<string, boolean>();
  await Promise.all(
    [...new Set([...perThread.values()].map((r) => `${r.nest_id}\u0000${r.node_id}`))].map(async (key) => {
      const [nestId, nodeId] = key.split("\u0000");
      allowed.set(key, await canOpenNode(nestId, nodeId, userId, email).catch(() => false));
    }),
  );

  const out: MentionItem[] = [];
  for (const r of perThread.values()) {
    if (!allowed.get(`${r.nest_id}\u0000${r.node_id}`)) continue;
    const actor = await resolveActorLabel({ email: r.author, client: deserializeClient(r.client_json) });
    const channel = config.EXPERIMENTAL_AGENT_STREAM && isChannelRow(r) ? r.node_id.split("/").pop()! : null;
    out.push({
      type: "mention",
      kind: channel ? "channel" : "document",
      nest_id: r.nest_id,
      nest_name: nestNames.get(r.nest_id) ?? r.nest_id,
      node_id: r.node_id,
      title: r.title || r.node_id.split("/").pop() || r.node_id,
      channel,
      thread_id: r.thread_id,
      comment_id: r.comment_id,
      excerpt: excerptOf(r.body),
      author: r.author,
      author_label: actor.label,
      agent: actor.agent,
      for_agent: r.mentioned_user_id ? null : r.handle,
      mentioned_at: toIso(r.created_at),
    });
  }
  return out;
}

/**
 * "nest\0node" for every document the caller has a mention row on, answered
 * or not — the inbox's "X mentioned you" rows for those are the same event
 * the Mentions section already carries, so My Work stops counting them twice.
 */
export async function mentionedNodeKeys(userId: string, nestIds: string[]): Promise<Set<string>> {
  if (!userId || nestIds.length === 0) return new Set();
  const rows = (await getDb().all(
    `SELECT DISTINCT nest_id, node_id FROM comment_mentions
      WHERE mentioned_user_id = ? AND nest_id IN (${nestIds.map(() => "?").join(", ")})`,
    [userId, ...nestIds],
  )) as Array<{ nest_id: string; node_id: string }>;
  return new Set(rows.map((r) => `${r.nest_id}\u0000${r.node_id}`));
}
