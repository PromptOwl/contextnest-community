/**
 * Direct and group conversations (team chat harness C2, PO-1197).
 *
 * A conversation is an ORDINARY NODE, `nodes/conversations/<uuid>` (engine
 * type document, tags #conversation, #conversation:dm | #conversation:group
 * and #private; its body names the members), with a fixed member list of
 * 2..N members of one nest: people as the node's `grants` rows, agents as
 * `agent:<handle>` tags (containers.ts). Its messages are the node's comment
 * threads, exactly like a channel's, so the channel read (`readChannel` with
 * a resolved container) and the thread routes serve it unchanged, and what
 * C1 adds to a message applies here too. Nothing new in the store: the node
 * store, the thread store, the grants table.
 *
 * WHO: a person added to the nest starts one (naming other people added to
 * it, or known agents); members read, post, mark read; a member of a GROUP
 * leaves it or adds another nest member; a dm is fixed. Nobody outside the
 * member list learns it exists: every read answers NotFound for "no such
 * conversation" and "not yours" alike (`getReadableConversation`), the
 * access guard hides the node from listings, and the nest middleware answers
 * the same 404 on the thread routes.
 *
 * An agent member reads with the key it runs on: the person behind that key
 * must be a member (containers.ts). Every message by someone else in the
 * conversation is put in front of the agent as if it had been @mentioned
 * (`indexAgentMembers`: a mention row, so My Work and the wake-up see it).
 */
import { randomUUID } from "node:crypto";
import type { ContextNode } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { nowMsExpr } from "../db/sql.js";
import { config } from "../config.js";
import { createNode } from "../nodes/service.js";
import { resolveNestAccess } from "../shared/access.js";
import { ConflictError, NotFoundError, ValidationError } from "../shared/errors.js";
import { channelStats, isNestMember, readChannel, timelineText, type ChannelTimeline, type ChannelView, type PostRefusal } from "../channels/channel-service.js";
import { readChannelDoc } from "../channels/channel-node.js";
import { normHandle } from "../channels/message-meta.js";
import { normalizeTag } from "../governance/tag-index-service.js";
import { emitChatEvent } from "./events.js";
import {
  addAgentMember,
  addPersonMember,
  agentMembers,
  agentTag,
  assertRoom,
  conversationDocs,
  conversationIdOf,
  conversationMemberKeys,
  CONVERSATION_TAG,
  isContainerMember,
  isConversationDoc,
  memberKeyOf,
  memberViews,
  newConversationId,
  PRIVATE_TAG,
  removePersonMember,
  resolveMemberSpecs,
  type MemberView,
} from "./containers.js";

export interface ConversationView {
  id: string;
  type: "conversation";
  kind: "dm" | "group";
  /** The other members' names, joined — what a list shows. */
  title: string;
  members: MemberView[];
  created_by: string;
  created_at: string;
  post_count: number;
  last_post_at: string | null;
  last_activity_at: string | null;
  /** Messages by others since the caller last marked it read. */
  unread: number;
  can_post: boolean;
  post_refusal: string | null;
}

interface Caller {
  nestId: string;
  userId: string;
  userEmail: string;
  crossNest?: boolean;
}

const NOT_FOUND = "Conversation not found";

function kindOf(node: ContextNode): "dm" | "group" {
  const tags = (Array.isArray(node.frontmatter?.tags) ? node.frontmatter.tags : []).map((t: unknown) => normalizeTag(String(t)));
  return tags.includes(`${CONVERSATION_TAG}:group`) ? "group" : "dm";
}

async function nestRefusal(nestId: string, userId: string): Promise<PostRefusal | null> {
  if (config.AUTH_MODE === "open") return null;
  const access = await resolveNestAccess(nestId, userId);
  if (access.archived) return { status: 403, error: "This nest is archived, so it is read-only." };
  return null;
}

/** The posting rule on a conversation id, for the thread routes: a member
 *  may (unless the nest is archived); anyone else is refused. */
export async function conversationPostRefusal(nestId: string, nodeId: string, userId: string, _userEmail: string): Promise<PostRefusal | null> {
  if (!(await isContainerMember(nestId, nodeId, userId))) return { status: 403, error: NOT_FOUND };
  return nestRefusal(nestId, userId);
}

function titleOf(members: MemberView[], me: string): string {
  const others = members.filter((m) => !(m.kind === "person" && m.email === me)).map((m) => (m.kind === "person" ? m.name : `@${m.handle}`));
  return others.join(", ") || "Just you";
}

async function toView(caller: Caller, node: ContextNode, members?: MemberView[], stats?: Map<string, { count: number; lastAt: string | null; lastActivityAt: string | null; unread: number }>, refusal?: PostRefusal | null): Promise<ConversationView> {
  const list = members ?? (await memberViews(caller.nestId, node.id, node));
  const st = (stats ?? (await channelStats(caller, [node.id]))).get(node.id);
  const post = refusal === undefined ? await nestRefusal(caller.nestId, caller.userId) : refusal;
  const fm = (node.frontmatter ?? {}) as { author?: unknown; created_at?: unknown };
  return {
    id: node.id,
    type: "conversation",
    kind: kindOf(node),
    title: titleOf(list, caller.userEmail.toLowerCase()),
    members: list,
    created_by: typeof fm.author === "string" ? fm.author : "",
    created_at: typeof fm.created_at === "string" ? fm.created_at : "",
    post_count: st?.count ?? 0,
    last_post_at: st?.lastAt ?? null,
    last_activity_at: st?.lastActivityAt ?? null,
    unread: st?.unread ?? 0,
    can_post: !post,
    post_refusal: post?.error ?? null,
  };
}

/** The conversation, if it exists in this nest and the caller is a member of
 *  it; NotFound otherwise — one answer, so no existence oracle. */
export async function getReadableConversation(caller: Caller, raw: unknown): Promise<{ node: ContextNode; view: ConversationView }> {
  const id = conversationIdOf(raw);
  if (!id) throw new NotFoundError(NOT_FOUND);
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError(NOT_FOUND);
  if (!(await isContainerMember(caller.nestId, id, caller.userId))) throw new NotFoundError(NOT_FOUND);
  const node = await readChannelDoc(caller.nestId, id);
  if (!node || !isConversationDoc(node)) throw new NotFoundError(NOT_FOUND);
  return { node, view: await toView(caller, node) };
}

/**
 * Create a conversation with exactly this member set, or find the one that
 * already has it. The caller is always a member. Two people → dm; more → a
 * group. Idempotent on the set: the same set again is the same conversation.
 */
export async function findOrCreateConversation(caller: Caller, rawMembers: unknown): Promise<{ conversation: ConversationView; created: boolean }> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Nest not found");
  const { people, agents } = await resolveMemberSpecs(caller.nestId, rawMembers);
  const me = caller.userEmail.toLowerCase();
  if (!people.some((p) => p.email === me)) people.push({ email: me, userId: caller.userId, name: null });
  if (people.length + agents.length < 2) throw new ValidationError("A conversation needs at least one other member.");
  const key = memberKeyOf(
    people.map((p) => p.email),
    agents,
  );
  // Found by its member set: the oldest node whose grants and agent tags
  // make the same key.
  const keys = await conversationMemberKeys(caller.nestId);
  const docs = (await conversationDocs(caller.nestId))
    .filter((d) => keys.get(d.id) === key)
    .sort((a, b) => String(a.frontmatter?.created_at ?? "").localeCompare(String(b.frontmatter?.created_at ?? "")));
  if (docs[0]) return { conversation: await toView(caller, docs[0]), created: false };

  const id = newConversationId();
  const kind = people.length + agents.length === 2 ? "dm" : "group";
  const names = await displayNamesOf(people.map((p) => p.email));
  const label = [...people.map((p) => names.get(p.email) ?? p.email), ...agents.map((h) => `@${h}`)].join(", ");
  await createNode(
    caller.nestId,
    {
      id,
      title: label.slice(0, 180),
      content: `${kind === "dm" ? "Direct message" : "Group conversation"} between ${label}. Messages are its threads; members are its shares.`,
      type: "document",
      tags: [`#${CONVERSATION_TAG}`, `#${CONVERSATION_TAG}:${kind}`, `#${PRIVATE_TAG}`, ...agents.map((h) => `#${agentTag(h)}`)],
    },
    me,
    { notifyMentions: false, creatorReviews: false },
  );
  for (const p of people) await addPersonMember(caller.nestId, id, p, me);
  const node = await readChannelDoc(caller.nestId, id);
  if (!node) throw new NotFoundError(NOT_FOUND);
  emitChatEvent(caller.nestId, { type: "conversation.created", conversation: id, kind, by: me });
  return { conversation: await toView(caller, node), created: true };
}

async function displayNamesOf(emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (emails.length === 0) return out;
  const rows = (await getDb().all(`SELECT LOWER(email) AS email, name FROM users WHERE LOWER(email) IN (${emails.map(() => "?").join(", ")})`, emails)) as Array<{
    email: string;
    name: string | null;
  }>;
  for (const r of rows) if (r.name?.trim()) out.set(r.email, r.name.trim());
  return out;
}

/** The conversations this caller is a member of, latest activity first. */
export async function listConversations(caller: Caller): Promise<{ conversations: ConversationView[] }> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Nest not found");
  const mine = (await getDb().all(
    "SELECT target FROM grants WHERE nest_id = ? AND user_id = ? AND target_type = 'document' AND target LIKE 'nodes/conversations/%'",
    [caller.nestId, caller.userId],
  )) as Array<{ target: string }>;
  const ids = new Set(mine.map((r) => r.target));
  const docs = (await conversationDocs(caller.nestId)).filter((d) => ids.has(d.id));
  const stats = await channelStats(caller, docs.map((d) => d.id));
  const refusal = await nestRefusal(caller.nestId, caller.userId);
  const views: ConversationView[] = [];
  for (const node of docs) views.push(await toView(caller, node, undefined, stats, refusal));
  views.sort((a, b) => ((a.last_activity_at ?? a.created_at) < (b.last_activity_at ?? b.created_at) ? 1 : -1));
  return { conversations: views };
}

export type ConversationTimeline =
  | { conversation: ConversationView; posts: Extract<ChannelTimeline, { posts: unknown }>["posts"]; pagination: Extract<ChannelTimeline, { posts: unknown }>["pagination"]; next_since: string }
  | { conversation: ConversationView; thread: Extract<ChannelTimeline, { thread: unknown }>["thread"] }
  | { conversation: ConversationView; messages: Extract<ChannelTimeline, { messages: unknown }>["messages"]; has_more: boolean; next_since: string };

/** A conversation's timeline, one thread, or what is new since — the channel
 *  read over the conversation's threads. */
export async function readConversation(
  caller: Caller,
  input: { conversation: unknown; thread?: unknown; since?: unknown; limit?: unknown; offset?: unknown },
): Promise<ConversationTimeline> {
  const { node, view } = await getReadableConversation(caller, input.conversation);
  const asChannel = view as unknown as ChannelView;
  const t = await readChannel(caller, { channel: node.id, thread: input.thread, since: input.since, limit: input.limit, offset: input.offset }, { node: { id: node.id }, view: asChannel });
  const { channel: _channel, ...rest } = t as ChannelTimeline & { channel: unknown };
  return { conversation: view, ...rest } as ConversationTimeline;
}

/** Plain-text rendering of a conversation read, for an agent over MCP. */
export function conversationText(t: ConversationTimeline): string {
  const { conversation, ...rest } = t;
  const channel = {
    ...conversation,
    name: conversation.id,
    title: `${conversation.kind === "dm" ? "Direct message" : "Group"}: ${conversation.title}`,
    purpose: `Members: ${conversation.members.map((m) => (m.kind === "person" ? m.name : `@${m.handle}`)).join(", ")}`,
    archived: false,
  } as unknown as ChannelView;
  return timelineText({ channel, ...rest } as ChannelTimeline)
    .replace(/context_channel_read \{ channel: /g, "context_conversation_read { conversation: ")
    .replace(/context_comment \{ channel: /g, "context_comment { id: ");
}

export async function markConversationRead(caller: Caller, raw: unknown): Promise<{ conversation: ConversationView }> {
  const { node } = await getReadableConversation(caller, raw);
  const db = getDb();
  await db.run(
    `INSERT INTO stream_marks (user_id, nest_id, kind, ref, subject, at)
     VALUES (?, ?, 'channel', ?, '', ${nowMsExpr(db)})
     ON CONFLICT (user_id, nest_id, kind, ref, subject) DO UPDATE SET at = excluded.at`,
    [caller.userId, caller.nestId, node.id],
  );
  emitChatEvent(caller.nestId, { type: "read.marked", conversation: node.id }, { only: caller.userId });
  return { conversation: await toView(caller, node) };
}

/** Leave a group. A dm is fixed (409). */
export async function leaveConversation(caller: Caller, raw: unknown): Promise<{ left: true; conversation: string }> {
  const { node, view } = await getReadableConversation(caller, raw);
  if (view.kind !== "group") throw new ConflictError("A direct message has a fixed pair of members; there is nothing to leave.");
  const me = caller.userEmail.toLowerCase();
  await removePersonMember(caller.nestId, node.id, caller.userId);
  emitChatEvent(caller.nestId, { type: "membership.changed", conversation: node.id, action: "left", member: me, by: me });
  return { left: true, conversation: node.id };
}

/** Add a person added to the nest (or a known agent) to a group. A dm is fixed (409). */
export async function addConversationMember(caller: Caller, raw: unknown, member: unknown): Promise<{ conversation: ConversationView }> {
  const { node, view } = await getReadableConversation(caller, raw);
  if (view.kind !== "group") throw new ConflictError("A direct message has a fixed pair of members; start a group to add someone.");
  if (typeof member !== "string" || !member.trim()) throw new ValidationError("member is required — a name, an email or an @handle.");
  const { people, agents } = await resolveMemberSpecs(caller.nestId, [member]);
  await assertRoom(caller.nestId, node.id);
  const me = caller.userEmail.toLowerCase();
  let added: string | null = null;
  for (const p of people) if (await addPersonMember(caller.nestId, node.id, p, me)) added = p.email;
  for (const h of agents) if (await addAgentMember(caller.nestId, node.id, h, me)) added = `@${h}`;
  if (added) emitChatEvent(caller.nestId, { type: "membership.changed", conversation: node.id, action: "added", member: added, by: me });
  const fresh = (await readChannelDoc(caller.nestId, node.id)) ?? node;
  return { conversation: await toView(caller, fresh) };
}

/**
 * After a message lands in a conversation: a mention row for every AGENT
 * member the message does not already name (and that didn't write it), so
 * the agent's My Work lists it and the wake-up goes out — a message to an
 * agent in its dm is addressed to it. Best-effort, like every fan-out.
 */
export async function indexAgentMembers(params: {
  nestId: string;
  nodeId: string;
  threadId: string;
  commentId: string | null;
  authorEmail: string;
  authorHandles: string[];
}): Promise<number> {
  const { nestId, nodeId, threadId, commentId } = params;
  if (!commentId) return 0;
  try {
    const handles = (await agentMembers(nestId, nodeId)).filter((h) => !params.authorHandles.includes(normHandle(h)));
    if (handles.length === 0) return 0;
    const db = getDb();
    const msg = (await db.get("SELECT created_at FROM annotation_comments WHERE id = ?", [commentId])) as { created_at: string } | undefined;
    if (!msg) return 0;
    let n = 0;
    for (const handle of handles) {
      const dup = await db.get("SELECT 1 AS hit FROM comment_mentions WHERE comment_id = ? AND mentioned_user_id IS NULL AND handle = ?", [commentId, handle]);
      if (dup) continue;
      await db.run(
        `INSERT INTO comment_mentions (id, nest_id, node_id, thread_id, comment_id, mentioned_user_id, handle, author, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [randomUUID(), nestId, nodeId, threadId, commentId, handle, params.authorEmail.toLowerCase(), msg.created_at],
      );
      n++;
    }
    return n;
  } catch (err) {
    console.error("[chat] agent member index failed", nestId, nodeId, err);
    return 0;
  }
}
