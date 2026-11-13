/**
 * Channels — agent team stream, S1 (PO-1179). Experimental, behind
 * EXPERIMENTAL_AGENT_STREAM.
 *
 * A channel is an ORDINARY node: `nodes/channels/<name>`, engine type
 * `document`, tagged `#channel`, its body the channel's purpose. Nothing about
 * it is new to the engine, so `ctx` and `context_list` see it like any other
 * node (AC-CH-08). The engine's NODE_TYPES has no `channel`, so the type
 * reported here (`type: "channel"`) is this edition's view of it; when the
 * engine grows the type, `isChannelDoc` is the one place that changes.
 *
 * Its messages are that node's comment threads (src/annotations): a top-level
 * post is a thread, a reply is a comment in it. Posting goes through the
 * comment routes and MCP `context_comment` that already exist, with their
 * @mention / watcher fan-out (AC-CH-05). This module adds the read side (list,
 * timeline, one thread) and the one rule posting gains: a channel takes posts
 * from people who can WRITE in the nest, not from every reader
 * (`channelPostRefusal`, AC-CH-04).
 *
 * Access: every read resolves the channel through `getReadableChannel`, which
 * answers NotFound for "no such channel" and "can't read it" alike, so nothing
 * here is an existence oracle. The nest middleware (app.ts) has already 404ed
 * a caller with no access to the nest at all.
 */
import type { ContextNode } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { engineCache } from "../nodes/engine.js";
import { createNode, updateNode } from "../nodes/service.js";
import { canReadNode, filterAccessible } from "../governance/access-guard.js";
import { canCreateInNest, canUserEdit } from "../governance/stewardship-service.js";
import { normalizeTag } from "../governance/tag-index-service.js";
import { isPublicReader, resolveNestAccess } from "../shared/access.js";
import { deserializeClient, type ClientMetadata } from "../shared/client-metadata.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { config } from "../config.js";
import { isMetaFile } from "../nodes/meta-files.js";
import { resolveActorLabel, type ActorLabel } from "./actor-label.js";

export const CHANNEL_FOLDER = "channels";
export const CHANNEL_TAG = "channel";
export const ARCHIVED_TAG = "archived";
/** The longest purpose a channel keeps (its node body). */
export const MAX_PURPOSE_LENGTH = 4000;
export const DEFAULT_TIMELINE_LIMIT = 50;
export const MAX_TIMELINE_LIMIT = 200;
const MAX_TIMELINE_OFFSET = 10_000;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CHANNEL_ID_RE = /^nodes\/channels\/([a-z0-9][a-z0-9-]{0,62})$/;

// ─── Names and ids ──────────────────────────────────────────────────────

/** A channel name as typed ("#Ops", "ops") → its slug, or a ValidationError. */
export function parseChannelName(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("name is required — the channel's name, e.g. \"ops\".");
  const name = raw.trim().replace(/^#/, "").toLowerCase();
  if (!NAME_RE.test(name)) {
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

/** Cheap pre-filter: could this node id be a channel at all? */
export function isChannelId(nodeId: string): boolean {
  return CHANNEL_ID_RE.test(nodeId);
}

function tagsOf(node: ContextNode): string[] {
  const raw = node.frontmatter?.tags;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
}

function hasTag(node: ContextNode, tag: string): boolean {
  return tagsOf(node).some((t) => normalizeTag(t) === tag);
}

/** A channel = a direct child of `nodes/channels/` carrying the #channel tag. */
export function isChannelDoc(node: ContextNode): boolean {
  return isChannelId(node.id) && hasTag(node, CHANNEL_TAG);
}

// ─── Views ──────────────────────────────────────────────────────────────

export interface ChannelView {
  id: string;
  name: string;
  title: string;
  type: "channel";
  /** The node body. Null for a caller who reads the nest only publicly: the
   *  live body may be an unreviewed draft. */
  purpose: string | null;
  archived: boolean;
  post_count: number;
  last_post_at: string | null;
}

async function postStats(
  nestId: string,
  nodeIds: string[],
): Promise<Map<string, { count: number; lastAt: string | null }>> {
  const out = new Map<string, { count: number; lastAt: string | null }>();
  if (nodeIds.length === 0) return out;
  const rows = (await getDb().all(
    `SELECT node_id, CAST(COUNT(*) AS INTEGER) AS count, MAX(created_at) AS last_at
       FROM annotation_threads
      WHERE nest_id = ? AND node_id IN (${nodeIds.map(() => "?").join(", ")})
      GROUP BY node_id`,
    [nestId, ...nodeIds],
  )) as Array<{ node_id: string; count: number | string; last_at: string | null }>;
  for (const r of rows) out.set(r.node_id, { count: Number(r.count), lastAt: r.last_at });
  return out;
}

function toView(
  node: ContextNode,
  stats: { count: number; lastAt: string | null } | undefined,
  publicReader: boolean,
): ChannelView {
  const name = CHANNEL_ID_RE.exec(node.id)![1];
  return {
    id: node.id,
    name,
    title: String(node.frontmatter?.title ?? `#${name}`),
    type: "channel",
    purpose: publicReader ? null : String(node.body ?? "").trim(),
    archived: hasTag(node, ARCHIVED_TAG),
    post_count: stats?.count ?? 0,
    last_post_at: stats?.lastAt ?? null,
  };
}

interface Caller {
  nestId: string;
  userId: string;
  userEmail: string;
}

async function readDoc(nestId: string, nodeId: string): Promise<ContextNode | null> {
  try {
    const { storage } = await engineCache.get(nestId);
    return await storage.readDocument(nodeId);
  } catch {
    return null;
  }
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
  const node = await readDoc(caller.nestId, channelIdFor(name));
  if (!node || !isChannelDoc(node)) throw new NotFoundError("Channel not found");
  if (!(await canReadNode(caller.nestId, node.id, caller.userId, caller.userEmail))) {
    throw new NotFoundError("Channel not found");
  }
  const stats = await postStats(caller.nestId, [node.id]);
  const view = toView(node, stats.get(node.id), await isPublicReader(caller.nestId, caller.userId));
  return { node, view };
}

// ─── List / create / archive ────────────────────────────────────────────

export async function listChannels(
  caller: Caller,
  opts: { includeArchived?: boolean } = {},
): Promise<{ channels: ChannelView[] }> {
  const { storage } = await engineCache.get(caller.nestId);
  const docs = (await storage.discoverDocuments()).filter(isChannelDoc);
  const readable = await filterAccessible(caller.nestId, caller.userId, caller.userEmail, docs);
  const stats = await postStats(caller.nestId, readable.map((d) => d.id));
  const publicReader = await isPublicReader(caller.nestId, caller.userId);
  const channels = readable
    .map((d) => toView(d, stats.get(d.id), publicReader))
    .filter((c) => opts.includeArchived || !c.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { channels };
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
  if (await readDoc(caller.nestId, id)) {
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

export async function setChannelArchived(
  caller: Caller & { client?: ClientMetadata },
  rawName: unknown,
  archived: boolean,
): Promise<{ channel: ChannelView }> {
  const { node, view } = await getReadableChannel(caller, rawName);
  if (config.AUTH_MODE !== "open" && !(await canUserEdit(caller.nestId, node.id, caller.userEmail)).allowed) {
    throw new ForbiddenError("Archiving a channel needs write access to it.");
  }
  if (view.archived !== archived) {
    const kept = tagsOf(node).filter((t) => normalizeTag(t) !== ARCHIVED_TAG);
    await updateNode(
      caller.nestId,
      node.id,
      {
        tags: archived ? [...kept, `#${ARCHIVED_TAG}`] : kept,
        changeNote: archived ? "Archived the channel" : "Unarchived the channel",
        ...(caller.client ? { client: caller.client } : {}),
      },
      caller.userEmail,
    );
  }
  return { channel: (await getReadableChannel(caller, view.name)).view };
}

// ─── Posting rule ───────────────────────────────────────────────────────

/** Is this node a channel? Cheap for every other id (regex first). */
export async function isChannelNode(nestId: string, nodeId: string): Promise<boolean> {
  if (!isChannelId(nodeId)) return false;
  const node = await readDoc(nestId, nodeId);
  return !!node && isChannelDoc(node);
}

/**
 * Why this caller may NOT post (open a thread, reply, resolve) on this node,
 * or null when they may — or when the node is not a channel at all, which
 * leaves ordinary documents on their read-tier commenting rule.
 *
 * A channel is a team's working conversation, so posting is a write: the
 * nest's writers (owner, admin, write collaborator, editor steward, a write
 * share on the channel). Readers still read it. Enforced whatever the switch
 * says — it only ever narrows who may comment, never widens it.
 */
export async function channelPostRefusal(
  nestId: string,
  nodeId: string,
  userId: string,
  userEmail: string,
): Promise<{ status: 403 | 409; error: string } | null> {
  if (!isChannelId(nodeId)) return null;
  const node = await readDoc(nestId, nodeId);
  if (!node || !isChannelDoc(node)) return null;
  if (hasTag(node, ARCHIVED_TAG)) {
    return { status: 409, error: "This channel is archived. Unarchive it to post again." };
  }
  if (config.AUTH_MODE === "open") return null;
  if ((await resolveNestAccess(nestId, userId)).archived) {
    return { status: 403, error: "This nest is archived, so it is read-only." };
  }
  if ((await canUserEdit(nestId, nodeId, userEmail)).allowed) return null;
  return {
    status: 403,
    error: "Posting in a channel needs write access to the nest. You can read this channel, but not post in it.",
  };
}

// ─── Timeline ───────────────────────────────────────────────────────────

export interface ChannelMessage {
  id: string;
  author: string;
  actor: ActorLabel;
  body: string;
  created_at: string;
}

export interface ChannelPost extends ChannelMessage {
  /** The thread id — pass it as `thread` to read or reply to the thread. */
  status: "open" | "resolved";
  reply_count: number;
  last_reply_at: string | null;
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

async function toMessage(row: CommentRow): Promise<ChannelMessage> {
  return {
    id: row.id,
    author: row.author,
    actor: await resolveActorLabel({ email: row.author, client: deserializeClient(row.client_json) }),
    body: row.body,
    created_at: row.created_at,
  };
}

async function toPost(thread: ThreadRow, comments: CommentRow[]): Promise<ChannelPost> {
  const [first, ...replies] = comments;
  const opening = first
    ? await toMessage(first)
    : {
        id: thread.id,
        author: thread.created_by,
        actor: await resolveActorLabel({ email: thread.created_by }),
        body: "",
        created_at: thread.created_at,
      };
  return {
    ...opening,
    // The post IS the thread: its id is what `thread` takes everywhere.
    id: thread.id,
    created_at: thread.created_at,
    status: thread.status,
    reply_count: replies.length,
    last_reply_at: replies.length ? replies[replies.length - 1].created_at : null,
  };
}

export type ChannelTimeline =
  | {
      channel: ChannelView;
      posts: ChannelPost[];
      pagination: { total: number; limit: number; offset: number; has_more: boolean };
    }
  | { channel: ChannelView; thread: { post: ChannelPost; replies: ChannelMessage[] } };

/**
 * The channel's timeline (top-level posts newest first, paged) or, with
 * `thread`, one post and its replies oldest first. The REST route and MCP
 * `context_channel_read` both return exactly this object (AC-CH-07).
 */
export async function readChannel(
  caller: Caller,
  input: { channel: unknown; thread?: unknown; limit?: unknown; offset?: unknown },
): Promise<ChannelTimeline> {
  const { node, view } = await getReadableChannel(caller, input.channel);
  const db = getDb();

  const threadId = typeof input.thread === "string" ? input.thread.trim() : "";
  if (input.thread !== undefined && input.thread !== null && input.thread !== "") {
    // Scoped to THIS channel's node in THIS nest: a thread id from another
    // node or nest is simply not found here.
    const row = threadId
      ? ((await db.get(
          "SELECT id, created_by, created_at, status FROM annotation_threads WHERE id = ? AND nest_id = ? AND node_id = ?",
          [threadId, caller.nestId, node.id],
        )) as ThreadRow | undefined)
      : undefined;
    if (!row) throw new NotFoundError("Thread not found in this channel");
    const comments = (await commentsFor([row.id])).get(row.id) ?? [];
    const post = await toPost(row, comments);
    const replies = await Promise.all(comments.slice(1).map(toMessage));
    return { channel: view, thread: { post, replies } };
  }

  const limit = parseLimit(input.limit);
  const offset = parseOffset(input.offset);
  const totalRow = (await db.get(
    "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM annotation_threads WHERE nest_id = ? AND node_id = ?",
    [caller.nestId, node.id],
  )) as { n: number | string } | undefined;
  const total = Number(totalRow?.n ?? 0);
  const threads = (await db.all(
    `SELECT id, created_by, created_at, status FROM annotation_threads
      WHERE nest_id = ? AND node_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [caller.nestId, node.id, limit, offset],
  )) as ThreadRow[];
  const byThread = await commentsFor(threads.map((t) => t.id));
  const posts = await Promise.all(threads.map((t) => toPost(t, byThread.get(t.id) ?? [])));
  return {
    channel: view,
    posts,
    pagination: { total, limit, offset, has_more: offset + posts.length < total },
  };
}

/** Plain-text rendering of a timeline, for an agent reading over MCP. */
export function timelineText(t: ChannelTimeline): string {
  const head = `# ${t.channel.title}${t.channel.archived ? " (archived)" : ""}${
    t.channel.purpose ? `\n\n${t.channel.purpose}` : ""
  }`;
  if ("thread" in t) {
    const { post, replies } = t.thread;
    const lines = [
      `## Thread ${post.id} (${post.status})`,
      `- **${post.actor.label}** (${post.created_at}): ${post.body}`,
      ...replies.map((r) => `  - **${r.actor.label}** (${r.created_at}): ${r.body}`),
    ];
    return `${head}\n\n${lines.join("\n")}\n\nReply with context_comment { id: "${t.channel.id}", thread: "${post.id}", body }.`;
  }
  if (t.posts.length === 0) {
    return `${head}\n\nNo posts yet. Post with context_comment { id: "${t.channel.id}", body }.`;
  }
  const lines = t.posts.map(
    (p) =>
      `- [${p.id}] **${p.actor.label}** (${p.created_at}): ${p.body}${
        p.reply_count ? ` — ${p.reply_count} repl${p.reply_count === 1 ? "y" : "ies"}` : ""
      }`,
  );
  const { total, offset, has_more } = t.pagination;
  return `${head}\n\n${t.posts.length} of ${total} post(s), newest first${offset ? `, from ${offset}` : ""}:\n${lines.join(
    "\n",
  )}${has_more ? `\n\nMore: pass offset ${offset + t.posts.length}.` : ""}\n\nRead a thread with context_channel_read { channel: "${
    t.channel.name
  }", thread: "<id>" }; post with context_comment { id: "${t.channel.id}", body } (add thread to reply).`;
}
