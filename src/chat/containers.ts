/**
 * Chat containers and their members (team chat harness C2, PO-1197).
 *
 * A CONTAINER is anything the comment-thread store files messages under:
 *   - a public channel, `nodes/channels/<name>` (an ordinary node);
 *   - a PRIVATE channel, the same node plus a `chat_containers` row of kind
 *     'channel' and a member list in `chat_members`;
 *   - a conversation, `chat/conversations/<uuid>`: a row of kind 'dm' or
 *     'group' and a member list, and NO node — it is a container the message
 *     code addresses by id exactly as it addresses a channel node, which is
 *     what lets every message feature (threads, mentions, cards, `?since=`,
 *     unread, promote, and what C1 adds) apply to it unchanged.
 *
 * MEMBERS are people (by lowercased email, with their user id) or agents (by
 * handle, as `/agent-handles` names them, stored as `agent:<handle>`). Access
 * is decided by PEOPLE: a caller reads a conversation or a private channel
 * when their user id is on it. An agent reads with the key it runs on, so the
 * person behind that key must be a member; a key labelled with the agent's
 * handle grants nothing by itself (anyone could mint one).
 *
 * `containerReadVerdict` is the hook the access guard calls: true/false for a
 * container with a member list, null for everything else (an ordinary node or
 * a public channel keeps its usual rule).
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import { isChannelId } from "../channels/channel-node.js";
import { knownAgents, normHandle } from "../channels/message-meta.js";
import { listNestPeople, type NestPerson } from "../nests/people-service.js";
import { resolveMention } from "../shared/mentions.js";
import { ValidationError } from "../shared/errors.js";

export const CONVERSATION_PREFIX = "chat/conversations/";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CONVERSATION_ID_RE = new RegExp(`^chat/conversations/(${UUID})$`, "i");
const BARE_UUID_RE = new RegExp(`^${UUID}$`, "i");

/** Most members a conversation may have (people and agents together). */
export const MAX_CONVERSATION_MEMBERS = 50;

export function isConversationId(id: string): boolean {
  return CONVERSATION_ID_RE.test(id);
}

/** "chat/conversations/<uuid>" or a bare uuid → the container id; null otherwise. */
export function conversationIdOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (CONVERSATION_ID_RE.test(s)) return `${CONVERSATION_PREFIX}${CONVERSATION_ID_RE.exec(s)![1].toLowerCase()}`;
  if (BARE_UUID_RE.test(s)) return `${CONVERSATION_PREFIX}${s.toLowerCase()}`;
  return null;
}

export function newConversationId(): string {
  return `${CONVERSATION_PREFIX}${randomUUID()}`;
}

/** Is this container id a chat container at all (a channel node or a conversation)? */
export function isContainerId(id: string): boolean {
  return isChannelId(id) || isConversationId(id);
}

export const agentMemberKey = (handle: string) => `agent:${normHandle(handle)}`;

export interface ContainerRow {
  id: string;
  nest_id: string;
  kind: "dm" | "group" | "channel";
  member_key: string;
  created_by: string;
  created_at: string;
}

export interface MemberRow {
  member: string;
  user_id: string | null;
  added_by: string;
  added_at: string;
}

export type MemberView =
  | { kind: "person"; email: string; name: string; added_at: string }
  | { kind: "agent"; handle: string; added_at: string };

const nowIso = () => new Date().toISOString();

export async function getContainer(nestId: string, id: string): Promise<ContainerRow | undefined> {
  return (await getDb().get("SELECT id, nest_id, kind, member_key, created_by, created_at FROM chat_containers WHERE nest_id = ? AND id = ?", [
    nestId,
    id,
  ])) as ContainerRow | undefined;
}

/** A channel node is private while it has a container row. */
export async function isPrivateChannel(nestId: string, nodeId: string): Promise<boolean> {
  if (!isChannelId(nodeId)) return false;
  return !!(await getDb().get("SELECT 1 AS hit FROM chat_containers WHERE nest_id = ? AND id = ? AND kind = 'channel'", [nestId, nodeId]));
}

export async function privateChannelIds(nestId: string): Promise<Set<string>> {
  const rows = (await getDb().all("SELECT id FROM chat_containers WHERE nest_id = ? AND kind = 'channel'", [nestId])) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

export async function listMembers(nestId: string, container: string): Promise<MemberRow[]> {
  return (await getDb().all(
    "SELECT member, user_id, added_by, added_at FROM chat_members WHERE nest_id = ? AND container = ? ORDER BY added_at ASC, member ASC",
    [nestId, container],
  )) as MemberRow[];
}

export async function isContainerMember(nestId: string, container: string, userId: string): Promise<boolean> {
  if (!userId) return false;
  return !!(await getDb().get("SELECT 1 AS hit FROM chat_members WHERE nest_id = ? AND container = ? AND user_id = ?", [nestId, container, userId]));
}

/** The containers (ids) this user is a member of in the nest. */
export async function memberContainers(nestId: string, userId: string): Promise<Set<string>> {
  if (!userId) return new Set();
  const rows = (await getDb().all("SELECT container FROM chat_members WHERE nest_id = ? AND user_id = ?", [nestId, userId])) as Array<{
    container: string;
  }>;
  return new Set(rows.map((r) => r.container));
}

export async function addPersonMember(nestId: string, container: string, person: { email: string; userId: string }, addedBy: string): Promise<boolean> {
  const db = getDb();
  const email = person.email.toLowerCase();
  const before = await db.get("SELECT 1 AS hit FROM chat_members WHERE nest_id = ? AND container = ? AND member = ?", [nestId, container, email]);
  if (before) return false;
  await db.run("INSERT INTO chat_members (nest_id, container, member, user_id, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)", [
    nestId,
    container,
    email,
    person.userId,
    addedBy.toLowerCase(),
    nowIso(),
  ]);
  return true;
}

export async function addAgentMember(nestId: string, container: string, handle: string, addedBy: string): Promise<boolean> {
  const db = getDb();
  const key = agentMemberKey(handle);
  const before = await db.get("SELECT 1 AS hit FROM chat_members WHERE nest_id = ? AND container = ? AND member = ?", [nestId, container, key]);
  if (before) return false;
  await db.run("INSERT INTO chat_members (nest_id, container, member, user_id, added_by, added_at) VALUES (?, ?, ?, NULL, ?, ?)", [
    nestId,
    container,
    key,
    addedBy.toLowerCase(),
    nowIso(),
  ]);
  return true;
}

export async function removeMember(nestId: string, container: string, memberKey: string): Promise<void> {
  await getDb().run("DELETE FROM chat_members WHERE nest_id = ? AND container = ? AND member = ?", [nestId, container, memberKey]);
}

export async function removeAllMembers(nestId: string, container: string): Promise<void> {
  await getDb().run("DELETE FROM chat_members WHERE nest_id = ? AND container = ?", [nestId, container]);
}

/** The agent handles on a container's member list. */
export function agentHandlesOf(rows: MemberRow[]): string[] {
  return rows.filter((r) => r.member.startsWith("agent:")).map((r) => r.member.slice("agent:".length));
}

/** Display rows for a member list (names from the users table). */
export async function memberViews(nestId: string, container: string, rows?: MemberRow[]): Promise<MemberView[]> {
  const members = rows ?? (await listMembers(nestId, container));
  const emails = members.filter((m) => !m.member.startsWith("agent:")).map((m) => m.member);
  const names = new Map<string, string>();
  for (let i = 0; i < emails.length; i += 200) {
    const chunk = emails.slice(i, i + 200);
    if (!chunk.length) break;
    const found = (await getDb().all(`SELECT LOWER(email) AS email, name FROM users WHERE LOWER(email) IN (${chunk.map(() => "?").join(", ")})`, chunk)) as Array<{
      email: string;
      name: string | null;
    }>;
    for (const r of found) names.set(r.email, r.name?.trim() || r.email);
  }
  return members.map((m) =>
    m.member.startsWith("agent:")
      ? { kind: "agent", handle: m.member.slice("agent:".length), added_at: m.added_at }
      : { kind: "person", email: m.member, name: names.get(m.member) ?? m.member, added_at: m.added_at },
  );
}

/**
 * The deterministic key of a member set: sorted people (by email) and agents
 * (by handle), joined — the same set always makes the same key, so a dm or a
 * group is found again by its members.
 */
export function memberKeyOf(people: Iterable<string>, agents: Iterable<string>): string {
  const p = [...new Set([...people].map((e) => e.toLowerCase()))].sort();
  const a = [...new Set([...agents].map((h) => normHandle(h)))].sort();
  return [...p, ...a.map((h) => `agent:${h}`)].join("\n");
}

export async function refreshMemberKey(nestId: string, container: string): Promise<void> {
  const rows = await listMembers(nestId, container);
  const key = memberKeyOf(
    rows.filter((r) => !r.member.startsWith("agent:")).map((r) => r.member),
    agentHandlesOf(rows),
  );
  await getDb().run("UPDATE chat_containers SET member_key = ? WHERE nest_id = ? AND id = ?", [key, nestId, container]);
}

/**
 * Is this caller allowed to read this container? true / false when the
 * container has a member list (a conversation, a private channel); null when
 * it has none — the caller's usual node rule decides.
 *
 * A conversation id that does not exist is `false`: there is nothing to read,
 * and "no such conversation" and "not yours" must be one answer.
 */
export async function containerReadVerdict(nestId: string, nodeId: string, userId: string): Promise<boolean | null> {
  if (isConversationId(nodeId)) {
    return isContainerMember(nestId, nodeId, userId);
  }
  if (isChannelId(nodeId) && (await isPrivateChannel(nestId, nodeId))) {
    return isContainerMember(nestId, nodeId, userId);
  }
  return null;
}

/**
 * Among these node ids, the private channels this caller is NOT a member of
 * (so a listing drops them). Only ids under nodes/channels/ are looked at;
 * two small queries however many nodes are passed.
 */
export async function hiddenContainersFor(nestId: string, userId: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.some((id) => isChannelId(id))) return out;
  const priv = await privateChannelIds(nestId);
  if (priv.size === 0) return out;
  const mine = await memberContainers(nestId, userId);
  for (const id of ids) if (priv.has(id) && !mine.has(id)) out.add(id);
  return out;
}

// ─── Resolving "who" ────────────────────────────────────────────────────

export interface ResolvedMembers {
  people: Array<{ email: string; userId: string; name: string | null }>;
  agents: string[];
}

/** A person added to the nest (never a share grantee or a directory match). */
function onTheNest(p: NestPerson | undefined): p is NestPerson & { userId: string } {
  return !!p && !!p.userId && p.source !== "grant" && p.source !== "directory";
}

/**
 * Member specs ("rita", "rita@acme.com", "@grok") → people added to the nest
 * and known agent handles. Refuses (400) a spec that matches neither — without
 * echoing who it might have been — and a set that is not a list.
 */
export async function resolveMemberSpecs(nestId: string, raw: unknown): Promise<ResolvedMembers> {
  if (!Array.isArray(raw)) throw new ValidationError("members must be a list of people (name or email) and agents (@handle).");
  if (raw.length > MAX_CONVERSATION_MEMBERS) throw new ValidationError(`A conversation has at most ${MAX_CONVERSATION_MEMBERS} members.`);
  const roster = await listNestPeople(nestId);
  let agents: Map<string, true> | undefined;
  const people = new Map<string, { email: string; userId: string; name: string | null }>();
  const handles = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) throw new ValidationError("Each member is a name, an email or an @handle.");
    const spec = item.trim();
    const bare = spec.replace(/^@/, "");
    const person = resolveMention(roster, bare);
    if (onTheNest(person)) {
      people.set(person.email.toLowerCase(), { email: person.email.toLowerCase(), userId: person.userId, name: person.name });
      continue;
    }
    agents ??= new Map((await knownAgents(nestId)).map((a) => [a.handle, true]));
    const h = normHandle(bare);
    if (agents.has(h)) {
      handles.add(h);
      continue;
    }
    throw new ValidationError(`"${spec}" is not a person added to this nest or a known agent handle.`);
  }
  return { people: [...people.values()], agents: [...handles] };
}
