/**
 * Direct and group conversations (team chat harness C2, PO-1197).
 *
 * A conversation is a container (`chat/conversations/<uuid>`, containers.ts)
 * with a fixed member list of 2..N members of one nest: people, and agents by
 * handle. It has no node; its messages are comment threads filed under the
 * container id, exactly like a channel's, so the channel read
 * (`readChannel` with a resolved container) and the thread routes serve it
 * unchanged, and what C1 adds to a message applies here too.
 *
 * WHO: a person added to the nest starts one (naming other people added to
 * it, or known agents); members read, post, mark read; a member of a GROUP
 * leaves it or adds another nest member; a dm is fixed. Nobody outside the
 * member list learns it exists: every read answers NotFound for "no such
 * conversation" and "not yours" alike (`getReadableConversation`), and the
 * nest middleware answers the same 404 on the thread routes.
 *
 * An agent member reads with the key it runs on: the person behind that key
 * must be a member (containers.ts). Every message by someone else in the
 * conversation is put in front of the agent as if it had been @mentioned
 * (`indexAgentMembers`: a mention row, so My Work and the wake-up see it).
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import { nowMsExpr } from "../db/sql.js";
import { config } from "../config.js";
import { resolveNestAccess } from "../shared/access.js";
import { ConflictError, NotFoundError, ValidationError } from "../shared/errors.js";
import { channelStats, isNestMember, readChannel, timelineText, type ChannelTimeline, type ChannelView, type PostRefusal } from "../channels/channel-service.js";
import { normHandle } from "../channels/message-meta.js";
import { emitChatEvent } from "./events.js";
import {
  addAgentMember,
  addPersonMember,
  agentHandlesOf,
  conversationIdOf,
  getContainer,
  isContainerMember,
  listMembers,
  memberKeyOf,
  memberViews,
  newConversationId,
  refreshMemberKey,
  removeMember,
  resolveMemberSpecs,
  type ContainerRow,
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

async function toView(caller: Caller, row: ContainerRow): Promise<ConversationView> {
  const [members, stats, refusal] = await Promise.all([memberViews(caller.nestId, row.id), channelStats(caller, [row.id]), nestRefusal(caller.nestId, caller.userId)]);
  const st = stats.get(row.id);
  return {
    id: row.id,
    type: "conversation",
    kind: row.kind === "group" ? "group" : "dm",
    title: titleOf(members, caller.userEmail.toLowerCase()),
    members,
    created_by: row.created_by,
    created_at: row.created_at,
    post_count: st?.count ?? 0,
    last_post_at: st?.lastAt ?? null,
    last_activity_at: st?.lastActivityAt ?? null,
    unread: st?.unread ?? 0,
    can_post: !refusal,
    post_refusal: refusal?.error ?? null,
  };
}

/** The conversation, if it exists in this nest and the caller is a member of
 *  it; NotFound otherwise — one answer, so no existence oracle. */
export async function getReadableConversation(caller: Caller, raw: unknown): Promise<{ row: ContainerRow; view: ConversationView }> {
  const id = conversationIdOf(raw);
  if (!id) throw new NotFoundError(NOT_FOUND);
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError(NOT_FOUND);
  const row = await getContainer(caller.nestId, id);
  if (!row || row.kind === "channel") throw new NotFoundError(NOT_FOUND);
  if (!(await isContainerMember(caller.nestId, id, caller.userId))) throw new NotFoundError(NOT_FOUND);
  return { row, view: await toView(caller, row) };
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
  const db = getDb();
  const existing = (await db.get(
    "SELECT id, nest_id, kind, member_key, created_by, created_at FROM chat_containers WHERE nest_id = ? AND kind IN ('dm', 'group') AND member_key = ? ORDER BY created_at ASC LIMIT 1",
    [caller.nestId, key],
  )) as ContainerRow | undefined;
  if (existing) return { conversation: await toView(caller, existing), created: false };

  const id = newConversationId();
  const kind = people.length + agents.length === 2 ? "dm" : "group";
  await db.run("INSERT INTO chat_containers (id, nest_id, kind, member_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    caller.nestId,
    kind,
    key,
    me,
    new Date().toISOString(),
  ]);
  for (const p of people) await addPersonMember(caller.nestId, id, p, me);
  for (const h of agents) await addAgentMember(caller.nestId, id, h, me);
  const row = (await getContainer(caller.nestId, id))!;
  emitChatEvent(caller.nestId, { type: "conversation.created", conversation: id, kind, by: me });
  return { conversation: await toView(caller, row), created: true };
}

/** The conversations this caller is a member of, latest activity first. */
export async function listConversations(caller: Caller): Promise<{ conversations: ConversationView[] }> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Nest not found");
  const rows = (await getDb().all(
    `SELECT c.id, c.nest_id, c.kind, c.member_key, c.created_by, c.created_at
       FROM chat_containers c JOIN chat_members m ON m.nest_id = c.nest_id AND m.container = c.id
      WHERE c.nest_id = ? AND c.kind IN ('dm', 'group') AND m.user_id = ?
      ORDER BY c.created_at DESC`,
    [caller.nestId, caller.userId],
  )) as ContainerRow[];
  const stats = await channelStats(caller, rows.map((r) => r.id));
  const refusal = await nestRefusal(caller.nestId, caller.userId);
  const me = caller.userEmail.toLowerCase();
  const views: ConversationView[] = [];
  for (const row of rows) {
    const members = await memberViews(caller.nestId, row.id);
    const st = stats.get(row.id);
    views.push({
      id: row.id,
      type: "conversation",
      kind: row.kind === "group" ? "group" : "dm",
      title: titleOf(members, me),
      members,
      created_by: row.created_by,
      created_at: row.created_at,
      post_count: st?.count ?? 0,
      last_post_at: st?.lastAt ?? null,
      last_activity_at: st?.lastActivityAt ?? null,
      unread: st?.unread ?? 0,
      can_post: !refusal,
      post_refusal: refusal?.error ?? null,
    });
  }
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
  const { row, view } = await getReadableConversation(caller, input.conversation);
  const asChannel = view as unknown as ChannelView;
  const t = await readChannel(caller, { channel: row.id, thread: input.thread, since: input.since, limit: input.limit, offset: input.offset }, { node: { id: row.id }, view: asChannel });
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
  const { row } = await getReadableConversation(caller, raw);
  const db = getDb();
  await db.run(
    `INSERT INTO stream_marks (user_id, nest_id, kind, ref, subject, at)
     VALUES (?, ?, 'channel', ?, '', ${nowMsExpr(db)})
     ON CONFLICT (user_id, nest_id, kind, ref, subject) DO UPDATE SET at = excluded.at`,
    [caller.userId, caller.nestId, row.id],
  );
  emitChatEvent(caller.nestId, { type: "read.marked", conversation: row.id }, { only: caller.userId });
  return { conversation: await toView(caller, row) };
}

/** Leave a group. A dm is fixed (409). */
export async function leaveConversation(caller: Caller, raw: unknown): Promise<{ left: true; conversation: string }> {
  const { row } = await getReadableConversation(caller, raw);
  if (row.kind !== "group") throw new ConflictError("A direct message has a fixed pair of members; there is nothing to leave.");
  const me = caller.userEmail.toLowerCase();
  await removeMember(caller.nestId, row.id, me);
  await refreshMemberKey(caller.nestId, row.id);
  emitChatEvent(caller.nestId, { type: "membership.changed", conversation: row.id, action: "left", member: me, by: me });
  return { left: true, conversation: row.id };
}

/** Add a person added to the nest (or a known agent) to a group. A dm is fixed (409). */
export async function addConversationMember(caller: Caller, raw: unknown, member: unknown): Promise<{ conversation: ConversationView }> {
  const { row } = await getReadableConversation(caller, raw);
  if (row.kind !== "group") throw new ConflictError("A direct message has a fixed pair of members; start a group to add someone.");
  if (typeof member !== "string" || !member.trim()) throw new ValidationError("member is required — a name, an email or an @handle.");
  const { people, agents } = await resolveMemberSpecs(caller.nestId, [member]);
  const me = caller.userEmail.toLowerCase();
  let added: string | null = null;
  for (const p of people) if (await addPersonMember(caller.nestId, row.id, p, me)) added = p.email;
  for (const h of agents) if (await addAgentMember(caller.nestId, row.id, h, me)) added = `@${h}`;
  if (added) {
    await refreshMemberKey(caller.nestId, row.id);
    emitChatEvent(caller.nestId, { type: "membership.changed", conversation: row.id, action: "added", member: added, by: me });
  }
  return { conversation: await toView(caller, row) };
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
    const handles = agentHandlesOf(await listMembers(nestId, nodeId)).filter((h) => !params.authorHandles.includes(normHandle(h)));
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
