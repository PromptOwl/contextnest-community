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
import { isChannelId, CHANNEL_TAG } from "../channels/channel-node.js";
import { displayNames, namedActor, normHandle, writerHandlesOf } from "../channels/message-meta.js";
import { normalizeTag } from "../governance/tag-index-service.js";
import { nowMsExpr } from "../db/sql.js";
import { NotFoundError } from "../shared/errors.js";
import { config } from "../config.js";
import { agentHandlesOwnedBy } from "./agent-mentions.js";
import { isBroadcastName } from "../channels/broadcast.js";

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
  /** The row's time for a name, when not the message's own (an edit stamps
   *  the names it added with the edit's time; PO-1196). */
  at?: (name: string) => string | undefined;
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
    const rows: Array<{ userId: string | null; handle: string; at?: string }> = [];
    for (const name of names) {
      if (rows.length >= MAX_MENTION_RECIPIENTS) break;
      const person = resolveMention(roster, name) ?? (await findDirectoryPerson(name));
      if (person?.userId) {
        if (person.email.toLowerCase() === author || people.has(person.userId)) continue;
        people.add(person.userId);
        rows.push({ userId: person.userId, handle: person.email.toLowerCase(), at: params.at?.(name) });
        continue;
      }
      // A steward invited by email who never signed up has an email but no
      // account: nobody to put it in front of, and not an agent either.
      if (person) continue;
      // `@channel` / `@here` are a broadcast (channels/broadcast.ts), never a
      // handle that could be woken.
      if (isBroadcastName(name)) continue;
      const handle = name.trim().toLowerCase();
      if (!handle || handles.has(handle)) continue;
      handles.add(handle);
      rows.push({ userId: null, handle, at: params.at?.(name) });
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
        [uuid(), nestId, nodeId, threadId, commentId, r.userId, r.handle, author, r.at ?? msg.created_at],
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
  /** The person the message is attributed to (their email). */
  author: string;
  /** That person's display name (their email when they have none). */
  author_name: string;
  /** "<agent>, on behalf of <person>" or the person, by display name. */
  author_label: string;
  /** The agent that wrote it on the author's behalf, when one did. */
  agent: string | null;
  /** Null when the caller was named; the agent's handle when an agent the
   *  caller owns (agent-mentions.ts) or is acting as (`actingAs`) was. */
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

/** A handle as an agent may be tagged; anything else is not an agent label. */
const AGENT_LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * The agent handle a call is acting as: the caller-declared `client.agent`,
 * else the API key's label (what shared/client-metadata.ts derives), when it
 * has the shape of a handle. Null for a person in the browser.
 *
 * A LABEL, never an identity (AC-AX-01): it only widens which handle rows
 * match, and every row is still limited to nests the caller can see and nodes
 * the caller can open. Claiming "grok" shows you the @grok threads you could
 * already read, nothing else.
 */
export function actingAgentHandle(client: { agent?: unknown } | null | undefined): string | null {
  const h = normHandle(client?.agent);
  return AGENT_LABEL_RE.test(h) ? h : null;
}

const key = (nestId: string, nodeId: string) => `${nestId}\u0000${nodeId}`;

/**
 * Every open thread that @mentions the caller (or an agent the caller owns,
 * or the agent this call is acting as) and that hasn't been answered or
 * marked done since, newest mention first, one item per thread and subject —
 * in the given nests only, and only on nodes the caller can open now. Returns
 * the whole filtered list; the caller pages it, so `total` and the badge
 * count exactly what can be shown (AC-MW-03/04).
 *
 * "Answered" for the person (and for an owned agent): a later message in the
 * thread under their login. For the agent the call acts as (AC-AX-01): a
 * later message under this login written AS that agent — so the person
 * behind the key tagging their own agent still lands in the agent's queue,
 * and someone else claiming the label can't clear it.
 */
export async function listOpenMentions(params: {
  userId: string;
  email: string;
  /** Nest id → display name: the nests the caller may see items from. */
  nestNames: Map<string, string>;
  /** The agent handle this call is acting as (actingAgentHandle), if any. */
  actingAs?: string | null;
}): Promise<MentionItem[]> {
  const { userId, email, nestNames } = params;
  const nestIds = [...nestNames.keys()];
  if (nestIds.length === 0 || !userId) return [];
  const me = email.toLowerCase();
  const acting = params.actingAs ? normHandle(params.actingAs) : "";
  const owned = (await agentHandlesOwnedBy({ userId, email })).filter((h) => h !== acting);
  const ownedClause = owned.length
    ? ` OR (m.mentioned_user_id IS NULL AND m.handle IN (${owned.map(() => "?").join(", ")}))`
    : "";
  // `acting` is matched even when empty: no handle is the empty string.
  const rows = (await getDb().all(
    `SELECT m.nest_id, m.node_id, m.thread_id, m.comment_id, m.mentioned_user_id, m.handle,
            c.author, m.created_at, c.body, c.client_json, ni.title, ni.frontmatter_json
       FROM comment_mentions m
       JOIN annotation_threads t ON t.id = m.thread_id
       JOIN annotation_comments c ON c.id = m.comment_id
       LEFT JOIN node_index ni ON ni.nest_id = m.nest_id AND ni.node_id = m.node_id
       LEFT JOIN stream_marks d
         ON d.user_id = ? AND d.nest_id = m.nest_id AND d.kind = 'mention' AND d.ref = m.thread_id
        AND d.subject = (CASE WHEN m.mentioned_user_id IS NULL THEN m.handle ELSE '' END)
      WHERE m.nest_id IN (${nestIds.map(() => "?").join(", ")})
        AND t.status = 'open'
        AND t.nest_id = m.nest_id
        AND (d.at IS NULL OR d.at < m.created_at)
        AND (
          (m.mentioned_user_id IS NULL AND m.handle = ?)
          OR ((m.mentioned_user_id = ?${ownedClause})
              AND LOWER(m.author) <> ?
              AND NOT EXISTS (
                SELECT 1 FROM annotation_comments r
                 WHERE r.thread_id = m.thread_id
                   AND LOWER(r.author) = ?
                   AND r.id <> m.comment_id
                   AND r.created_at >= m.created_at))
        )
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${MAX_SCAN}`,
    [userId, ...nestIds, acting, userId, ...owned, me, me],
  )) as Row[];

  // The acting agent's rows: drop what this agent wrote itself, and what it
  // has answered since (a later message under this login, as that agent).
  const actingRows = rows.filter((r) => !r.mentioned_user_id && r.handle === acting);
  const answeredAt = new Map<string, string>();
  if (actingRows.length) {
    const threadIds = [...new Set(actingRows.map((r) => r.thread_id))];
    for (let i = 0; i < threadIds.length; i += 200) {
      const chunk = threadIds.slice(i, i + 200);
      const mine = (await getDb().all(
        `SELECT thread_id, created_at, client_json FROM annotation_comments
          WHERE thread_id IN (${chunk.map(() => "?").join(", ")}) AND LOWER(author) = ? AND client_json IS NOT NULL
          ORDER BY created_at ASC`,
        [...chunk, me],
      )) as Array<{ thread_id: string; created_at: string; client_json: string | null }>;
      // Keep the LATEST message written as the agent, per thread.
      for (const c of mine) if (writerHandlesOf(c.client_json).includes(acting)) answeredAt.set(c.thread_id, c.created_at);
    }
  }
  const open = rows.filter((r) => {
    if (r.mentioned_user_id || r.handle !== acting) return true;
    if (r.author.toLowerCase() === me && writerHandlesOf(r.client_json).includes(acting)) return false;
    const answered = answeredAt.get(r.thread_id);
    return !answered || answered < r.created_at;
  });

  // One item per thread and subject: the newest unanswered mention in it.
  const perThread = new Map<string, Row>();
  for (const r of open) {
    const k = `${r.thread_id}\u0000${r.mentioned_user_id ? "" : r.handle}`;
    if (!perThread.has(k)) perThread.set(k, r);
  }

  // Access, per distinct node, at read time — losing read on a nest or a
  // document takes its mentions (and their count) away at once.
  const allowed = new Map<string, boolean>();
  await Promise.all(
    [...new Set([...perThread.values()].map((r) => key(r.nest_id, r.node_id)))].map(async (k) => {
      const [nestId, nodeId] = k.split("\u0000");
      allowed.set(k, await canOpenNode(nestId, nodeId, userId, email).catch(() => false));
    }),
  );

  const shown = [...perThread.values()].filter((r) => allowed.get(key(r.nest_id, r.node_id)));
  const names = await displayNames(shown.map((r) => r.author));
  const out: MentionItem[] = [];
  for (const r of shown) {
    const { actor, name } = await namedActor(r.author, deserializeClient(r.client_json), names);
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
      author_name: name,
      author_label: actor.label,
      agent: actor.agent,
      for_agent: r.mentioned_user_id ? null : r.handle,
      mentioned_at: toIso(r.created_at),
    });
  }
  return out;
}

/**
 * "Mark done" (PO-1189, AC-UX-09): the caller is finished with their mention
 * in this thread. It leaves their My Work and badge until a LATER message in
 * the thread names them again; the message, the thread and everyone else's
 * view are untouched.
 *
 * The mark is the caller's own row, so it can only ever hide the caller's own
 * mention. It is still refused (NotFound, the same answer for every reason)
 * unless the caller has an open mention in that thread right now — so a
 * thread id is no existence oracle, and nobody stores marks for threads they
 * were never tagged in or for an agent they don't act for.
 */
export async function markMentionDone(params: {
  userId: string;
  email: string;
  nestNames: Map<string, string>;
  threadId: unknown;
  /** Clear the mention of this agent handle instead of the caller's own. */
  forAgent?: unknown;
  actingAs?: string | null;
}): Promise<{ done: true; thread_id: string; for_agent: string | null }> {
  const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
  const forAgent = params.forAgent === undefined || params.forAgent === null || params.forAgent === "" ? null : normHandle(params.forAgent);
  const mine = threadId
    ? (await listOpenMentions(params)).find((m) => m.thread_id === threadId && m.for_agent === forAgent)
    : undefined;
  if (!mine) throw new NotFoundError("No open mention of yours in that thread");
  const db = getDb();
  await db.run(
    `INSERT INTO stream_marks (user_id, nest_id, kind, ref, subject, at)
     VALUES (?, ?, 'mention', ?, ?, ${nowMsExpr(db)})
     ON CONFLICT (user_id, nest_id, kind, ref, subject) DO UPDATE SET at = excluded.at`,
    [params.userId, mine.nest_id, threadId, forAgent ?? ""],
  );
  return { done: true, thread_id: threadId, for_agent: forAgent };
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
