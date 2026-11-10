/**
 * Channels — agent team stream (PO-1179; reworked for PO-1189 / PO-1190).
 * Experimental, behind EXPERIMENTAL_AGENT_STREAM.
 *
 * A channel is an ORDINARY node: `nodes/channels/<name>`, engine type
 * `document`, tagged `#channel`, its body the channel's purpose. Nothing about
 * it is new to the engine, so `ctx` and `context_list` see it like any other
 * node (AC-CH-08). The engine's NODE_TYPES has no `channel`, so the type
 * reported here (`type: "channel"`) is this edition's view of it; when the
 * engine grows the type, `isChannelDoc` (channel-node.ts) is the one place
 * that changes.
 *
 * Its messages are that node's comment threads (src/annotations): a top-level
 * post is a thread, a reply is a comment in it. Posting goes through the
 * comment routes and MCP `context_comment` that already exist, with their
 * @mention fan-out (AC-CH-05). Messages live in this server's database, not
 * in nest files; promote (stream/promote.ts) is the bridge into governed
 * nodes. This module is the read side (list, timeline, one thread, what is
 * new since) and the access rules.
 *
 * WHO MAY DO WHAT (owner decision 2026-11-09; one rule, `channelAccess`):
 *
 *   read   people added to the nest who can open the node (`canOpenNode`),
 *          plus a share on the channel node itself through the node's own
 *          thread routes. Never someone who reaches the nest only because it
 *          is public or org-visible: the access guard refuses them every
 *          channel node, approved or not (AC-AX-10).
 *   post   (open a thread, reply, resolve, reopen) the same people added to
 *          the nest: owner, admin, any collaborator including read-only, a
 *          steward, a member through a team share. Never the public, never
 *          someone whose only way in is a share, and not into an archived
 *          channel or nest. A read-only API key is stopped earlier, by the
 *          capability gate.
 *   manage (create, archive, restore; promote a thread) the nest's writers,
 *          as before.
 *
 * Every read resolves the channel through `getReadableChannel`, which answers
 * NotFound for "no such channel" and "can't read it" alike, so nothing here is
 * an existence oracle.
 */
import type { ContextNode } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { nowMsExpr } from "../db/sql.js";
import { engineCache } from "../nodes/engine.js";
import { createNode, updateNode } from "../nodes/service.js";
import { filterAccessible } from "../governance/access-guard.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { canCreateInNest, canUserEdit } from "../governance/stewardship-service.js";
import { normalizeTag } from "../governance/tag-index-service.js";
import { resolveNestAccess } from "../shared/access.js";
import { deserializeClient, type ClientMetadata } from "../shared/client-metadata.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { config } from "../config.js";
import { isMetaFile } from "../nodes/meta-files.js";
import type { ActorLabel } from "./actor-label.js";
import { cardsText, resolveMessageCards, type ArtifactCard } from "../stream/artifact-cards.js";
import { promotedFromThreads, type PromotedRef } from "../stream/promote.js";
import { knowledgeCounts } from "../memory/knowledge.js";
import { relatedNodesForThreads, relatedNodesText, type RelatedNode } from "../memory/links.js";
import { watcherFor } from "../memory/watcher.js";
import {
  ARCHIVED_TAG,
  CHANNEL_FOLDER,
  CHANNEL_NAME_RE,
  CHANNEL_TAG,
  channelNameOf,
  hasTag,
  isChannelDoc,
  isChannelId,
  isChannelNode,
  readChannelDoc,
  tagsOf,
} from "./channel-node.js";
import { bodyMentions, displayNames, knownAgents, namedActor, type KnownAgent, type MentionRef } from "./message-meta.js";

export { ARCHIVED_TAG, CHANNEL_FOLDER, CHANNEL_TAG, isChannelDoc, isChannelId, isChannelNode } from "./channel-node.js";

/** The longest purpose a channel keeps (its node body). */
export const MAX_PURPOSE_LENGTH = 4000;
export const DEFAULT_TIMELINE_LIMIT = 50;
export const MAX_TIMELINE_LIMIT = 200;
const MAX_TIMELINE_OFFSET = 10_000;

// ─── Names and ids ──────────────────────────────────────────────────────

/**
 * A channel as typed — "ops", "#Ops", "channels/ops" or its node id
 * "nodes/channels/ops" — → its slug, or a ValidationError. One spelling rule
 * for reading and for posting (AC-AX-03).
 */
export function parseChannelName(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("name is required — the channel's name, e.g. \"ops\".");
  const name = raw
    .trim()
    .replace(/^(nodes\/)?channels\//i, "")
    .replace(/^#/, "")
    .toLowerCase();
  if (!CHANNEL_NAME_RE.test(name)) {
    throw new ValidationError(
      "A channel name is 1–63 characters: lowercase letters, digits and dashes, starting with a letter or digit.",
    );
  }
  // `nodes/channels/agents.md` is an AGENTS.md as far as the vault is
  // concerned (likewise INDEX, CONTEXT, CLAUDE, README…): the engine
  // regenerates those files and discovery hides them, so such a channel would
  // vanish from every listing and be overwritten.
  if (isMetaFile(name)) {
    throw new ValidationError(`"${name}" is reserved for a file the vault generates; pick another channel name.`);
  }
  return name;
}

export function channelIdFor(name: string): string {
  return `nodes/${CHANNEL_FOLDER}/${name}`;
}

// ─── Access ─────────────────────────────────────────────────────────────

interface Caller {
  nestId: string;
  userId: string;
  userEmail: string;
  /** May artifact cards resolve links into other nests? (S3: false for a
   *  nest-scoped key, true for a session or an unscoped key.) */
  crossNest?: boolean;
}

export type PostRefusal = { status: 403 | 409; error: string };

const NOT_A_MEMBER =
  "Posting in a channel is for people added to this nest. Ask the nest's owner to add you as a collaborator.";
const CHANNEL_ARCHIVED: PostRefusal = { status: 409, error: "This channel is archived. Restore it to post again." };

/**
 * A person added to the nest — owner, admin, a collaborator at any level, a
 * steward, or a member through a team share. Someone who reaches the nest
 * only through its visibility (public, org) or only through a document share
 * is not.
 */
const isMember = (access: { permission: string; isPublicReader: boolean }) =>
  access.permission !== "none" && !access.isPublicReader;

/** Is this caller a person added to the nest? (Open mode: everyone is.) */
export async function isNestMember(nestId: string, userId: string): Promise<boolean> {
  return config.AUTH_MODE === "open" || isMember(await resolveNestAccess(nestId, userId));
}

/** Why this caller may not post in ANY channel of the nest, or null: the nest
 *  is archived, or they are not a person added to it. */
async function nestPostRefusal(nestId: string, userId: string): Promise<PostRefusal | null> {
  if (config.AUTH_MODE === "open") return null;
  const access = await resolveNestAccess(nestId, userId);
  if (access.archived) return { status: 403, error: "This nest is archived, so it is read-only." };
  return isMember(access) ? null : { status: 403, error: NOT_A_MEMBER };
}

/**
 * The one access answer for a channel node: can this caller read it, and if
 * they may not post, why. `post: null` means they may.
 */
export async function channelAccess(
  caller: { nestId: string; userId: string; userEmail: string },
  node: ContextNode,
): Promise<{ read: boolean; post: PostRefusal | null }> {
  const read = await canOpenNode(caller.nestId, node.id, caller.userId, caller.userEmail);
  if (hasTag(node, ARCHIVED_TAG)) return { read, post: CHANNEL_ARCHIVED };
  const refusal = await nestPostRefusal(caller.nestId, caller.userId);
  return { read, post: refusal ?? (read ? null : { status: 403, error: NOT_A_MEMBER }) };
}

/**
 * Why this caller may NOT post (open a thread, reply, resolve, reopen) on
 * this node, or null when they may — or when the node is not a channel at
 * all, which leaves ordinary documents on their read-tier commenting rule.
 * Enforced whatever the switch says: it only ever narrows who may comment.
 * Shared by every path a message can arrive on (the thread routes, the older
 * flat /comments store, MCP, promote).
 */
export async function channelPostRefusal(
  nestId: string,
  nodeId: string,
  userId: string,
  userEmail: string,
): Promise<PostRefusal | null> {
  if (!isChannelId(nodeId)) return null;
  const node = await readChannelDoc(nestId, nodeId);
  if (!node) {
    // Unreadable, but known to be a channel: closed, not open (channel-node.ts).
    return (await isChannelNode(nestId, nodeId)) ? { status: 409, error: "This channel can't be read right now." } : null;
  }
  if (!isChannelDoc(node)) return null;
  return (await channelAccess({ nestId, userId, userEmail }, node)).post;
}

// ─── Views ──────────────────────────────────────────────────────────────

export interface ChannelView {
  id: string;
  name: string;
  title: string;
  type: "channel";
  /** The node body. */
  purpose: string | null;
  archived: boolean;
  /** Top-level posts (threads). */
  post_count: number;
  /** When the newest post was opened. */
  last_post_at: string | null;
  /** When the newest message — post or reply — was written. */
  last_activity_at: string | null;
  /** Messages by other people since this caller last marked the channel
   *  read (`POST …/channels/:name/read`). Never a total. */
  unread: number;
  /** May this caller post here, and if not, the one line to show instead of
   *  a composer. */
  can_post: boolean;
  post_refusal: string | null;
  /** Nodes this channel produced that the caller can read (team chat C6):
   *  promoted, remembered, corrected, proposed. See GET …/knowledge. */
  knowledge_count: number;
  /** A metacognition agent watches this channel (team chat C6). */
  watched: boolean;
}

interface Stats {
  count: number;
  lastAt: string | null;
  lastActivityAt: string | null;
  unread: number;
}

/** Post counts, latest activity and this caller's unread, for many channels
 *  in ONE query (the channel list is what a visible tab re-reads). */
async function channelStats(caller: Caller, nodeIds: string[]): Promise<Map<string, Stats>> {
  const out = new Map<string, Stats>();
  if (nodeIds.length === 0) return out;
  const rows = (await getDb().all(
    `SELECT t.node_id,
            CAST(COUNT(DISTINCT t.id) AS INTEGER) AS count,
            MAX(t.created_at) AS last_at,
            MAX(c.created_at) AS last_activity_at,
            CAST(SUM(CASE WHEN LOWER(c.author) <> ? AND (r.at IS NULL OR c.created_at > r.at) THEN 1 ELSE 0 END) AS INTEGER) AS unread
       FROM annotation_threads t
       JOIN annotation_comments c ON c.thread_id = t.id
       LEFT JOIN stream_marks r
         ON r.user_id = ? AND r.nest_id = t.nest_id AND r.kind = 'channel' AND r.ref = t.node_id AND r.subject = ''
      WHERE t.nest_id = ? AND t.node_id IN (${nodeIds.map(() => "?").join(", ")})
      GROUP BY t.node_id`,
    [caller.userEmail.toLowerCase(), caller.userId, caller.nestId, ...nodeIds],
  )) as Array<{ node_id: string; count: number | string; last_at: string | null; last_activity_at: string | null; unread: number | string | null }>;
  for (const r of rows) {
    out.set(r.node_id, {
      count: Number(r.count),
      lastAt: r.last_at,
      lastActivityAt: r.last_activity_at,
      unread: Number(r.unread ?? 0),
    });
  }
  return out;
}

function toView(node: ContextNode, stats: Stats | undefined, post: PostRefusal | null): ChannelView {
  const name = channelNameOf(node.id)!;
  return {
    id: node.id,
    name,
    title: String(node.frontmatter?.title ?? `#${name}`),
    type: "channel",
    purpose: String(node.body ?? "").trim(),
    archived: hasTag(node, ARCHIVED_TAG),
    post_count: stats?.count ?? 0,
    last_post_at: stats?.lastAt ?? null,
    last_activity_at: stats?.lastActivityAt ?? null,
    unread: stats?.unread ?? 0,
    can_post: !post,
    post_refusal: post?.error ?? null,
    knowledge_count: 0,
    watched: false,
  };
}

/** Fill the memory-snowball fields of channel views (team chat C6, PO-1199). */
async function withKnowledge(caller: Caller, views: ChannelView[]): Promise<ChannelView[]> {
  if (views.length === 0) return views;
  const counts = await knowledgeCounts(caller, views.map((v) => v.id)).catch(() => new Map<string, number>());
  for (const v of views) {
    v.knowledge_count = counts.get(v.id) ?? 0;
    v.watched = !!(await watcherFor(caller.nestId, v.name).catch(() => null))?.entry.enabled;
  }
  return views;
}

/** The channel by name, if it exists and the caller may read it; NotFound
 *  otherwise (same answer for both, so no existence oracle). */
export async function getReadableChannel(
  caller: Caller,
  rawName: unknown,
): Promise<{ node: ContextNode; view: ChannelView }> {
  let name: string;
  try {
    name = parseChannelName(rawName);
  } catch {
    throw new NotFoundError("Channel not found");
  }
  const node = await readChannelDoc(caller.nestId, channelIdFor(name));
  if (!node || !isChannelDoc(node)) throw new NotFoundError("Channel not found");
  const access = await channelAccess(caller, node);
  if (!access.read) throw new NotFoundError("Channel not found");
  const stats = await channelStats(caller, [node.id]);
  const [view] = await withKnowledge(caller, [toView(node, stats.get(node.id), access.post)]);
  return { node, view };
}

// ─── List / create / archive / mark read ────────────────────────────────

export interface ChannelList {
  channels: ChannelView[];
  /** The name of the not-archived channel with the newest message, or null:
   *  where a person landing on the page should start. */
  most_recent: string | null;
  /** May this caller create, archive and restore channels (a nest writer)? */
  can_manage: boolean;
}

export async function listChannels(
  caller: Caller,
  opts: { includeArchived?: boolean } = {},
): Promise<ChannelList> {
  const { storage } = await engineCache.get(caller.nestId);
  const docs = (await storage.discoverDocuments()).filter(isChannelDoc);
  // Narrows a share grantee to their grants, and drops every channel for a
  // caller who reaches the nest only through its visibility.
  const readable = await filterAccessible(caller.nestId, caller.userId, caller.userEmail, docs);
  const stats = await channelStats(caller, readable.map((d) => d.id));
  // The posting rule is the same for every channel but its archived tag, so
  // the nest-level half is resolved once.
  const refusal = await nestPostRefusal(caller.nestId, caller.userId);
  const all = await withKnowledge(
    caller,
    readable.map((d) => toView(d, stats.get(d.id), hasTag(d, ARCHIVED_TAG) ? CHANNEL_ARCHIVED : refusal)),
  );
  const live = all.filter((c) => !c.archived);
  const most = live
    .filter((c) => c.last_activity_at)
    .sort((a, b) => (a.last_activity_at! < b.last_activity_at! ? 1 : -1))[0];
  return {
    channels: (opts.includeArchived ? all : live).sort((a, b) => a.name.localeCompare(b.name)),
    most_recent: most?.name ?? null,
    can_manage: await canCreateInNest(caller.nestId, caller.userEmail),
  };
}

export async function createChannel(
  caller: Caller & { client?: ClientMetadata },
  input: { name: unknown; purpose?: unknown },
): Promise<{ channel: ChannelView }> {
  const name = parseChannelName(input.name);
  if (input.purpose !== undefined && input.purpose !== null && typeof input.purpose !== "string") {
    throw new ValidationError("purpose must be a string");
  }
  const purpose = String(input.purpose ?? "").trim();
  if (purpose.length > MAX_PURPOSE_LENGTH) {
    throw new ValidationError(`purpose is at most ${MAX_PURPOSE_LENGTH} characters`);
  }
  // Same rule as creating any document (REST middleware + MCP context_create).
  if (!(await canCreateInNest(caller.nestId, caller.userEmail))) {
    throw new ForbiddenError("Creating a channel needs write access to this nest.");
  }
  const id = channelIdFor(name);
  if (await readChannelDoc(caller.nestId, id)) {
    throw new ConflictError(`A channel or document already exists at ${id}.`);
  }
  await createNode(
    caller.nestId,
    {
      id,
      title: `#${name}`,
      // The body is the purpose; without one, a line that says what the node
      // is, so it reads sensibly in ctx / context_get.
      content: purpose || `Channel #${name}.`,
      type: "document",
      tags: [`#${CHANNEL_TAG}`],
      ...(caller.client ? { client: caller.client } : {}),
    },
    caller.userEmail,
  );
  return { channel: (await getReadableChannel(caller, name)).view };
}

/** Archive (`archived: true`) or restore (`false`) a channel. Writers only. */
export async function setChannelArchived(
  caller: Caller & { client?: ClientMetadata },
  rawName: unknown,
  archived: boolean,
): Promise<{ channel: ChannelView }> {
  const { node, view } = await getReadableChannel(caller, rawName);
  if (config.AUTH_MODE !== "open" && !(await canUserEdit(caller.nestId, node.id, caller.userEmail)).allowed) {
    throw new ForbiddenError("Archiving or restoring a channel needs write access to it.");
  }
  if (view.archived !== archived) {
    const kept = tagsOf(node).filter((t) => normalizeTag(t) !== ARCHIVED_TAG);
    await updateNode(
      caller.nestId,
      node.id,
      {
        tags: archived ? [...kept, `#${ARCHIVED_TAG}`] : kept,
        changeNote: archived ? "Archived the channel" : "Restored the channel",
        ...(caller.client ? { client: caller.client } : {}),
      },
      caller.userEmail,
    );
  }
  return { channel: (await getReadableChannel(caller, view.name)).view };
}

/**
 * "I have read this channel" (PO-1189, AC-UX-05): the caller's own mark, as
 * of now. Their `unread` for it drops to 0 and counts up again from the next
 * message someone else writes. Anyone who can read the channel may.
 */
export async function markChannelRead(caller: Caller, rawName: unknown): Promise<{ channel: ChannelView }> {
  const { node, view } = await getReadableChannel(caller, rawName);
  const db = getDb();
  await db.run(
    `INSERT INTO stream_marks (user_id, nest_id, kind, ref, subject, at)
     VALUES (?, ?, 'channel', ?, '', ${nowMsExpr(db)})
     ON CONFLICT (user_id, nest_id, kind, ref, subject) DO UPDATE SET at = excluded.at`,
    [caller.userId, caller.nestId, node.id],
  );
  return { channel: (await getReadableChannel(caller, view.name)).view };
}

/**
 * The agent handles a composer can offer after "@" (PO-1189, AC-UX-07):
 * handles with a wake-up target plus declared agents seen in this nest's
 * channels. People added to the nest only; NotFound for anyone else.
 */
export async function listKnownAgents(caller: Caller): Promise<{ agents: KnownAgent[] }> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Not found");
  return { agents: await knownAgents(caller.nestId) };
}

// ─── Timeline ───────────────────────────────────────────────────────────

export interface ChannelMessage {
  id: string;
  /** The login the message is attributed to (an email). */
  author: string;
  /** That person's display name (their email when they have none). */
  author_name: string;
  /** Who to show: `human` is the display name; `agent` is set, and `label`
   *  reads "<agent>, on behalf of <person>", only when the caller declared an
   *  agent (message-meta.ts). */
  actor: ActorLabel;
  body: string;
  created_at: string;
  /** The artifacts the message links, resolved for THIS reader (PO-1181):
   *  a card for what they can read, `{ link, resolved: false }` for the rest. */
  cards: ArtifactCard[];
  /** Every `@name` in the body, in order: a person, a known agent, or nobody
   *  — so a client can style what landed and what didn't. */
  mentions: MentionRef[];
}

export interface ChannelPost extends ChannelMessage {
  /** The thread id — pass it as `thread` to read or reply to the thread. */
  status: "open" | "resolved";
  reply_count: number;
  last_reply_at: string | null;
  /** The newest message in the thread; the timeline is ordered by it. */
  last_activity_at: string;
  /** Nodes this thread was promoted to that the reader can open. */
  promoted: PromotedRef[];
  /** Nodes this thread touched — mentioned, promoted, remembered, corrected,
   *  proposed — that the reader can open (team chat C6, PO-1199). */
  related_nodes: RelatedNode[];
}

/** A message in a "what is new since" read: flat, oldest first. */
export interface ChannelNewMessage extends ChannelMessage {
  thread_id: string;
  /** False for the message that opened its thread. */
  reply: boolean;
}

interface ThreadRow {
  id: string;
  created_by: string;
  created_at: string;
  status: "open" | "resolved";
}

interface CommentRow {
  id: string;
  thread_id: string;
  author: string;
  body: string;
  created_at: string;
  client_json: string | null;
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n) || n < 1) return DEFAULT_TIMELINE_LIMIT;
  return Math.min(Math.floor(n), MAX_TIMELINE_LIMIT);
}

function parseOffset(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), MAX_TIMELINE_OFFSET);
}

async function commentsFor(threadIds: string[]): Promise<Map<string, CommentRow[]>> {
  const out = new Map<string, CommentRow[]>();
  if (threadIds.length === 0) return out;
  const rows = (await getDb().all(
    `SELECT id, thread_id, author, body, created_at, client_json
       FROM annotation_comments
      WHERE thread_id IN (${threadIds.map(() => "?").join(", ")})
      ORDER BY created_at ASC, id ASC`,
    threadIds,
  )) as CommentRow[];
  for (const r of rows) {
    const list = out.get(r.thread_id) ?? [];
    list.push(r);
    out.set(r.thread_id, list);
  }
  return out;
}

/**
 * Rows → messages, in one pass per concern: display names, the actor seam,
 * which @names resolved, and the reader's artifact cards. Same order out as in.
 */
async function toMessages(caller: Caller, rows: CommentRow[]): Promise<ChannelMessage[]> {
  if (rows.length === 0) return [];
  const bodies = rows.map((r) => r.body);
  const [names, mentions, cards] = await Promise.all([
    displayNames(rows.map((r) => r.author)),
    bodyMentions(caller.nestId, bodies),
    resolveMessageCards(caller, bodies),
  ]);
  return Promise.all(
    rows.map(async (row, i) => {
      const { actor, name } = await namedActor(row.author, deserializeClient(row.client_json), names);
      return {
        id: row.id,
        author: row.author,
        author_name: name,
        actor,
        body: row.body,
        created_at: row.created_at,
        cards: cards[i],
        mentions: mentions[i],
      };
    }),
  );
}

/** Threads → posts (the opening message of each, plus its thread's counts). */
async function toPosts(
  caller: Caller,
  hostNodeId: string,
  threads: ThreadRow[],
  byThread: Map<string, CommentRow[]>,
): Promise<{ posts: ChannelPost[]; replies: Map<string, ChannelMessage[]> }> {
  const all: CommentRow[] = [];
  for (const t of threads) all.push(...(byThread.get(t.id) ?? []));
  const messages = new Map((await toMessages(caller, all)).map((m, i) => [all[i].id, m]));
  const promoted = await promotedFromThreads(caller, threads.map((t) => t.id));
  const related = await relatedNodesForThreads(caller, hostNodeId, threads.map((t) => t.id)).catch(() => new Map<string, RelatedNode[]>());
  const posts: ChannelPost[] = [];
  const replies = new Map<string, ChannelMessage[]>();
  for (const t of threads) {
    const rows = byThread.get(t.id) ?? [];
    // A thread is created with its opening message in one transaction, so a
    // thread without one does not occur; skip rather than invent a message.
    if (rows.length === 0) continue;
    const rest = rows.slice(1).map((r) => messages.get(r.id)!);
    replies.set(t.id, rest);
    posts.push({
      ...messages.get(rows[0].id)!,
      // The post IS the thread: its id is what `thread` takes everywhere.
      id: t.id,
      created_at: t.created_at,
      status: t.status,
      reply_count: rest.length,
      last_reply_at: rest.length ? rest[rest.length - 1].created_at : null,
      last_activity_at: rows[rows.length - 1].created_at,
      promoted: promoted.get(t.id) ?? [],
      related_nodes: related.get(t.id) ?? [],
    });
  }
  return { posts, replies };
}

export type ChannelTimeline =
  | {
      channel: ChannelView;
      posts: ChannelPost[];
      pagination: { total: number; limit: number; offset: number; has_more: boolean };
      /** Pass as `since` next time to get only what was written after this read. */
      next_since: string;
    }
  | { channel: ChannelView; thread: { post: ChannelPost; replies: ChannelMessage[]; related_nodes: RelatedNode[] } }
  | {
      channel: ChannelView;
      /** Posts and replies written after `since`, oldest first. */
      messages: ChannelNewMessage[];
      has_more: boolean;
      next_since: string;
    };

/** "2026-11-09T13:41:44.927Z" → "2026-11-09 13:41:44.927", the stored form. */
function toStored(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/** A `since` value → the (created_at, id) a message must sort after. */
async function sinceCursor(nestId: string, nodeId: string, raw: string): Promise<{ at: string; id: string }> {
  const refuse = () =>
    new ValidationError("since is a message id from this channel (the next_since of an earlier read) or a timestamp.");
  if (/^\d{4}-\d\d-\d\d([T ]\d\d:\d\d(:\d\d(\.\d+)?)?)?(Z|[+-]\d\d:?\d\d)?$/.test(raw)) {
    const iso = raw.replace(" ", "T");
    const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(iso);
    // Stored times are UTC; a bare timestamp is read as UTC too.
    const ms = Date.parse(zoned ? iso : `${iso}${iso.includes("T") ? "" : "T00:00:00"}Z`);
    if (Number.isNaN(ms)) throw refuse();
    // "~" sorts after every id, so a message AT that instant is not "after" it.
    return { at: toStored(new Date(ms)), id: "~" };
  }
  if (raw.length > 100) throw refuse();
  const row = (await getDb().get(
    `SELECT c.id, c.created_at FROM annotation_comments c
       JOIN annotation_threads t ON t.id = c.thread_id
      WHERE c.id = ? AND t.nest_id = ? AND t.node_id = ?`,
    [raw, nestId, nodeId],
  )) as { id: string; created_at: string } | undefined;
  if (!row) throw refuse();
  return { at: row.created_at, id: row.id };
}

/**
 * Read a channel. Three shapes, the same object from REST and from MCP
 * `context_channel_read` (AC-CH-07):
 *
 *   timeline  top-level posts ordered by latest activity (a new reply moves
 *             its post up), paged with limit/offset;
 *   thread    one post and its replies oldest first (`thread`);
 *   since     only the posts and replies written after `since` (a message id
 *             or a timestamp), oldest first, with `next_since` to pass next
 *             time. When nothing is new it is the access check and one range
 *             query; no timeline, cards, names or mentions are built.
 */
export async function readChannel(
  caller: Caller,
  input: { channel: unknown; thread?: unknown; since?: unknown; limit?: unknown; offset?: unknown },
): Promise<ChannelTimeline> {
  const { node, view } = await getReadableChannel(caller, input.channel);
  const db = getDb();

  if (input.thread !== undefined && input.thread !== null && input.thread !== "") {
    const threadId = typeof input.thread === "string" ? input.thread.trim() : "";
    // Scoped to THIS channel's node in THIS nest: a thread id from another
    // node or nest is simply not found here.
    const row = threadId
      ? ((await db.get(
          "SELECT id, created_by, created_at, status FROM annotation_threads WHERE id = ? AND nest_id = ? AND node_id = ?",
          [threadId, caller.nestId, node.id],
        )) as ThreadRow | undefined)
      : undefined;
    if (!row) throw new NotFoundError("Thread not found in this channel");
    const { posts, replies } = await toPosts(caller, node.id, [row], await commentsFor([row.id]));
    if (!posts[0]) throw new NotFoundError("Thread not found in this channel");
    return { channel: view, thread: { post: posts[0], replies: replies.get(row.id) ?? [], related_nodes: posts[0].related_nodes } };
  }

  const limit = parseLimit(input.limit);

  if (input.since !== undefined && input.since !== null && input.since !== "") {
    const raw = String(input.since).trim();
    const cursor = await sinceCursor(caller.nestId, node.id, raw);
    const rows = (await db.all(
      `SELECT c.id, c.thread_id, c.author, c.body, c.created_at, c.client_json
         FROM annotation_comments c
         JOIN annotation_threads t ON t.id = c.thread_id
        WHERE t.nest_id = ? AND t.node_id = ?
          AND (c.created_at > ? OR (c.created_at = ? AND c.id > ?))
        ORDER BY c.created_at ASC, c.id ASC
        LIMIT ?`,
      [caller.nestId, node.id, cursor.at, cursor.at, cursor.id, limit + 1],
    )) as CommentRow[];
    const page = rows.slice(0, limit);
    if (page.length === 0) return { channel: view, messages: [], has_more: false, next_since: raw };
    // Which of these opened its thread: the thread's first message. Read
    // newest first, so the last write to the map per thread is its oldest.
    const threadIds = [...new Set(page.map((r) => r.thread_id))];
    const firsts = new Map<string, string>();
    for (const r of (await db.all(
      `SELECT thread_id, id FROM annotation_comments
        WHERE thread_id IN (${threadIds.map(() => "?").join(", ")})
        ORDER BY created_at DESC, id DESC`,
      threadIds,
    )) as Array<{ thread_id: string; id: string }>) {
      firsts.set(r.thread_id, r.id);
    }
    const messages = (await toMessages(caller, page)).map((m, i) => ({
      ...m,
      thread_id: page[i].thread_id,
      reply: firsts.get(page[i].thread_id) !== m.id,
    }));
    return { channel: view, messages, has_more: rows.length > limit, next_since: page[page.length - 1].id };
  }

  const offset = parseOffset(input.offset);
  const totalRow = (await db.get(
    "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM annotation_threads WHERE nest_id = ? AND node_id = ?",
    [caller.nestId, node.id],
  )) as { n: number | string } | undefined;
  const total = Number(totalRow?.n ?? 0);
  // Latest activity first: a thread's newest message, or its own start.
  const threads = (await db.all(
    `SELECT t.id, t.created_by, t.created_at, t.status
       FROM annotation_threads t
       LEFT JOIN annotation_comments c ON c.thread_id = t.id
      WHERE t.nest_id = ? AND t.node_id = ?
      GROUP BY t.id, t.created_by, t.created_at, t.status
      ORDER BY COALESCE(MAX(c.created_at), t.created_at) DESC, t.id DESC
      LIMIT ? OFFSET ?`,
    [caller.nestId, node.id, limit, offset],
  )) as ThreadRow[];
  const { posts } = await toPosts(caller, node.id, threads, await commentsFor(threads.map((t) => t.id)));
  const newest = (await db.get(
    `SELECT c.id FROM annotation_comments c
       JOIN annotation_threads t ON t.id = c.thread_id
      WHERE t.nest_id = ? AND t.node_id = ?
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT 1`,
    [caller.nestId, node.id],
  )) as { id: string } | undefined;
  return {
    channel: view,
    posts,
    pagination: { total, limit, offset, has_more: offset + posts.length < total },
    // An empty channel has no message to point at: start from now.
    next_since: newest?.id ?? new Date().toISOString(),
  };
}

function missedText(mentions: MentionRef[]): string {
  const missed = mentions.filter((m) => m.kind === "nobody").map((m) => `@${m.name}`);
  return missed.length ? ` [matched nobody: ${missed.join(", ")}]` : "";
}

/** Plain-text rendering of a read, for an agent over MCP. */
export function timelineText(t: ChannelTimeline): string {
  const head = `# ${t.channel.title}${t.channel.archived ? " (archived)" : ""}${
    t.channel.purpose ? `\n\n${t.channel.purpose}` : ""
  }`;
  const name = t.channel.name;
  if ("thread" in t) {
    const { post, replies } = t.thread;
    const lines = [
      `## Thread ${post.id} (${post.status})`,
      `- **${post.actor.label}** (${post.created_at}): ${post.body}${missedText(post.mentions)}${cardsText(post.cards)}`,
      ...replies.map(
        (r) => `  - **${r.actor.label}** (${r.created_at}): ${r.body}${missedText(r.mentions)}${cardsText(r.cards, "    ")}`,
      ),
    ];
    const promoted = post.promoted.length
      ? `\n\nPromoted to: ${post.promoted.map((p) => `${p.kind} "${p.title}" (${p.node_id})`).join("; ")}.`
      : "";
    return `${head}\n\n${lines.join("\n")}${promoted}${relatedNodesText(post.related_nodes)}\n\nReply with context_comment { channel: "${name}", thread: "${post.id}", body }. Keep something from it with context_remember { thread: "${post.id}" }.`;
  }
  if ("messages" in t) {
    if (t.messages.length === 0) return `${head}\n\nNothing new. Pass since: "${t.next_since}" again later.`;
    const lines = t.messages.map(
      (m) =>
        `- [thread ${m.thread_id}${m.reply ? ", reply" : ""}] **${m.actor.label}** (${m.created_at}): ${m.body}${missedText(m.mentions)}${cardsText(m.cards)}`,
    );
    return `${head}\n\n${t.messages.length} new message(s), oldest first:\n${lines.join("\n")}\n\n${
      t.has_more ? "More waiting. " : ""
    }Next time pass since: "${t.next_since}". Reply with context_comment { channel: "${name}", thread, body }.`;
  }
  if (t.posts.length === 0) {
    return `${head}\n\nNo posts yet. Post with context_comment { channel: "${name}", body }.`;
  }
  const lines = t.posts.map(
    (p) =>
      `- [${p.id}] **${p.actor.label}** (${p.created_at}): ${p.body}${
        p.reply_count ? ` — ${p.reply_count} repl${p.reply_count === 1 ? "y" : "ies"}, last ${p.last_activity_at}` : ""
      }${p.status === "resolved" ? " [resolved]" : ""}${p.promoted.length ? " [promoted]" : ""}${missedText(p.mentions)}${cardsText(p.cards)}`,
  );
  const { total, offset, has_more } = t.pagination;
  return `${head}\n\n${t.posts.length} of ${total} post(s), latest activity first${offset ? `, from ${offset}` : ""}:\n${lines.join(
    "\n",
  )}${has_more ? `\n\nMore: pass offset ${offset + t.posts.length}.` : ""}\n\nRead a thread with context_channel_read { channel: "${name}", thread: "<id>" }; next time pass since: "${
    t.next_since
  }" for only what is new; post with context_comment { channel: "${name}", body } (add thread to reply).`;
}
