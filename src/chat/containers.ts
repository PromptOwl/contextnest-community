/**
 * Chat containers and their members (team chat harness C2, PO-1197) — built
 * on what the server already has, nothing parallel:
 *
 *   container   an ORDINARY NODE whose comment threads are the messages:
 *               a channel `nodes/channels/<name>` (tag #channel), or a
 *               conversation `nodes/conversations/<uuid>` (tags
 *               #conversation, #conversation:dm | #conversation:group, and
 *               always #private). Same node store, same thread store, so
 *               every message feature — threads, mentions, cards, `?since=`,
 *               unread marks, promote, and what C1 adds — applies unchanged.
 *   private     the node carries the `#private` tag (read through the
 *               existing tag index, `node_tag_index`, which every write
 *               keeps in sync). A conversation is always private.
 *   members     the node's own `grants` rows (target_type 'document', role
 *               'read'): the existing per-document share mechanism, created
 *               through grants-service. People only — an agent member is a
 *               tag `agent:<handle>` on the node (an agent has no user to
 *               grant), addressed by handle as /agent-handles names it.
 *
 * ACCESS is decided by PEOPLE: a caller reads a conversation or a private
 * channel when they are a person added to the nest AND hold a grant on the
 * node (`containerReadVerdict`, the one hook the access guard calls). An
 * agent reads with the key it runs on, so the person behind that key must
 * be a member; a key labelled with the agent's handle grants nothing by
 * itself (anyone could mint one).
 */
import { randomUUID } from "node:crypto";
import type { ContextNode } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { engineCache } from "../nodes/engine.js";
import { updateNode } from "../nodes/service.js";
import { createGrant } from "../governance/grants-service.js";
import { normalizeTag } from "../governance/tag-index-service.js";
import { hasTag, isChannelId, readChannelDoc, tagsOf } from "../channels/channel-node.js";
import { knownAgents, normHandle } from "../channels/message-meta.js";
import { listNestPeople, type NestPerson } from "../nests/people-service.js";
import { resolveMention } from "../shared/mentions.js";
import { ValidationError } from "../shared/errors.js";

export const CONVERSATION_FOLDER = "conversations";
export const CONVERSATION_TAG = "conversation";
export const PRIVATE_TAG = "private";
const AGENT_TAG_PREFIX = "agent:";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CONVERSATION_ID_RE = new RegExp(`^nodes/conversations/(${UUID})$`, "i");
const BARE_UUID_RE = new RegExp(`^${UUID}$`, "i");

/** Most members a conversation may have (people and agents together). */
export const MAX_CONVERSATION_MEMBERS = 50;

export function isConversationId(id: string): boolean {
  return CONVERSATION_ID_RE.test(id);
}

/** "nodes/conversations/<uuid>", "conversations/<uuid>" or a bare uuid → the node id; null otherwise. */
export function conversationIdOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^conversations\//i, "nodes/conversations/");
  if (CONVERSATION_ID_RE.test(s)) return `nodes/${CONVERSATION_FOLDER}/${CONVERSATION_ID_RE.exec(s)![1].toLowerCase()}`;
  if (BARE_UUID_RE.test(s)) return `nodes/${CONVERSATION_FOLDER}/${s.toLowerCase()}`;
  return null;
}

export function newConversationId(): string {
  return `nodes/${CONVERSATION_FOLDER}/${randomUUID()}`;
}

/** A conversation = a node under nodes/conversations/ carrying #conversation. */
export function isConversationDoc(node: { id: string; frontmatter?: { tags?: unknown } | null }): boolean {
  return isConversationId(node.id) && hasTag(node, CONVERSATION_TAG);
}

export function isPrivateDoc(node: { frontmatter?: { tags?: unknown } | null }): boolean {
  return hasTag(node, PRIVATE_TAG);
}

export const agentTag = (handle: string) => `${AGENT_TAG_PREFIX}${normHandle(handle)}`;

export type MemberView =
  | { kind: "person"; email: string; name: string; added_at: string }
  | { kind: "agent"; handle: string; added_at: string };

// ─── Private marker (the tag index) ─────────────────────────────────────

/** Is this container private? The tag index first (kept in sync by every
 *  write), the document itself when the index has no row. */
export async function isPrivateContainer(nestId: string, nodeId: string): Promise<boolean> {
  if (isConversationId(nodeId)) return true;
  if (!isChannelId(nodeId)) return false;
  const hit = await getDb().get("SELECT 1 AS hit FROM node_tag_index WHERE nest_id = ? AND node_id = ? AND tag_name = ?", [nestId, nodeId, PRIVATE_TAG]);
  if (hit) return true;
  const node = await readChannelDoc(nestId, nodeId);
  return !!node && isPrivateDoc(node);
}

export const isPrivateChannel = isPrivateContainer;

/** Every private channel and conversation node of the nest, from the index. */
export async function privateContainerIds(nestId: string): Promise<Set<string>> {
  const rows = (await getDb().all(
    `SELECT node_id FROM node_tag_index
      WHERE nest_id = ? AND (tag_name = ? OR tag_name = ?)
        AND (node_id LIKE 'nodes/channels/%' OR node_id LIKE 'nodes/conversations/%')`,
    [nestId, PRIVATE_TAG, CONVERSATION_TAG],
  )) as Array<{ node_id: string }>;
  return new Set(rows.map((r) => r.node_id));
}

// ─── Members (grants rows) ──────────────────────────────────────────────

export async function isContainerMember(nestId: string, container: string, userId: string): Promise<boolean> {
  if (!userId) return false;
  return !!(await getDb().get("SELECT 1 AS hit FROM grants WHERE nest_id = ? AND user_id = ? AND target_type = 'document' AND target = ?", [
    nestId,
    userId,
    container,
  ]));
}

/** The chat containers this user holds a grant on in the nest. */
export async function memberContainers(nestId: string, userId: string): Promise<Set<string>> {
  if (!userId) return new Set();
  const rows = (await getDb().all(
    `SELECT target FROM grants WHERE nest_id = ? AND user_id = ? AND target_type = 'document'
        AND (target LIKE 'nodes/channels/%' OR target LIKE 'nodes/conversations/%')`,
    [nestId, userId],
  )) as Array<{ target: string }>;
  return new Set(rows.map((r) => r.target));
}

interface PersonRow {
  user_id: string;
  email: string;
  name: string | null;
  added_at: string;
}

export async function listPeople(nestId: string, container: string): Promise<PersonRow[]> {
  return (await getDb().all(
    `SELECT g.user_id, LOWER(u.email) AS email, u.name, g.created_at AS added_at
       FROM grants g JOIN users u ON u.id = g.user_id
      WHERE g.nest_id = ? AND g.target_type = 'document' AND g.target = ?
      ORDER BY g.created_at ASC, u.email ASC`,
    [nestId, container],
  )) as PersonRow[];
}

/** The agent handles on a container (its `agent:<handle>` tags). */
export async function agentMembers(nestId: string, container: string, node?: ContextNode | null): Promise<string[]> {
  const doc = node ?? (await readChannelDoc(nestId, container));
  if (doc) {
    return tagsOf(doc)
      .map(normalizeTag)
      .filter((t) => t.startsWith(AGENT_TAG_PREFIX))
      .map((t) => t.slice(AGENT_TAG_PREFIX.length));
  }
  const rows = (await getDb().all("SELECT tag_name FROM node_tag_index WHERE nest_id = ? AND node_id = ? AND tag_name LIKE 'agent:%'", [nestId, container])) as Array<{
    tag_name: string;
  }>;
  return rows.map((r) => r.tag_name.slice(AGENT_TAG_PREFIX.length));
}

/** Add a person as a member: a read grant on the node (grants-service; it
 *  emails nobody who is already on the nest). False when already a member. */
export async function addPersonMember(nestId: string, container: string, person: { email: string; userId: string }, addedBy: string): Promise<boolean> {
  if (await isContainerMember(nestId, container, person.userId)) return false;
  await createGrant({ nestId, targetType: "document", target: container, userId: person.userId, role: "read", grantedBy: addedBy.toLowerCase() });
  return true;
}

export async function removePersonMember(nestId: string, container: string, userId: string): Promise<void> {
  await getDb().run("DELETE FROM grants WHERE nest_id = ? AND user_id = ? AND target_type = 'document' AND target = ?", [nestId, userId, container]);
}

/** Add an agent by handle: an `agent:<handle>` tag on the node. False when already there. */
export async function addAgentMember(nestId: string, container: string, handle: string, byEmail: string): Promise<boolean> {
  const node = await readChannelDoc(nestId, container);
  if (!node) return false;
  const tag = agentTag(handle);
  const tags = tagsOf(node);
  if (tags.some((t) => normalizeTag(t) === tag)) return false;
  await updateNode(nestId, container, { tags: [...tags, `#${tag}`], changeNote: `Added @${normHandle(handle)}` }, byEmail);
  return true;
}

/** Display rows for a member list: people (grants) then agents (tags). */
export async function memberViews(nestId: string, container: string, node?: ContextNode | null): Promise<MemberView[]> {
  const [people, agents] = await Promise.all([listPeople(nestId, container), agentMembers(nestId, container, node)]);
  const added = (node?.frontmatter as { created_at?: unknown } | undefined)?.created_at;
  const agentAt = typeof added === "string" ? added : "";
  return [
    ...people.map((p): MemberView => ({ kind: "person", email: p.email, name: p.name?.trim() || p.email, added_at: p.added_at })),
    ...agents.map((h): MemberView => ({ kind: "agent", handle: h, added_at: agentAt })),
  ];
}

/**
 * The deterministic key of a member set: sorted people (by email) and agents
 * (by handle) — the same set always makes the same key, so a dm or a group
 * is found again by its members.
 */
export function memberKeyOf(people: Iterable<string>, agents: Iterable<string>): string {
  const p = [...new Set([...people].map((e) => e.toLowerCase()))].sort();
  const a = [...new Set([...agents].map((h) => normHandle(h)))].sort();
  return [...p, ...a.map((h) => `agent:${h}`)].join("\n");
}

/** Conversation node id → its member key, for every conversation in the nest
 *  (people from grants, agents from the tag index). */
export async function conversationMemberKeys(nestId: string): Promise<Map<string, string>> {
  const db = getDb();
  const people = (await db.all(
    `SELECT g.target, LOWER(u.email) AS email FROM grants g JOIN users u ON u.id = g.user_id
      WHERE g.nest_id = ? AND g.target_type = 'document' AND g.target LIKE 'nodes/conversations/%'`,
    [nestId],
  )) as Array<{ target: string; email: string }>;
  const agents = (await db.all(
    "SELECT node_id, tag_name FROM node_tag_index WHERE nest_id = ? AND node_id LIKE 'nodes/conversations/%' AND tag_name LIKE 'agent:%'",
    [nestId],
  )) as Array<{ node_id: string; tag_name: string }>;
  const p = new Map<string, string[]>();
  for (const r of people) p.set(r.target, [...(p.get(r.target) ?? []), r.email]);
  const a = new Map<string, string[]>();
  for (const r of agents) a.set(r.node_id, [...(a.get(r.node_id) ?? []), r.tag_name.slice(AGENT_TAG_PREFIX.length)]);
  const out = new Map<string, string>();
  for (const id of new Set([...p.keys(), ...a.keys()])) out.set(id, memberKeyOf(p.get(id) ?? [], a.get(id) ?? []));
  return out;
}

/**
 * Is this caller allowed to read this container? true / false for a
 * conversation or a private channel (members only); null for everything
 * else — the caller's usual node rule decides. A conversation id that does
 * not exist is `false`: "no such conversation" and "not yours" are one answer.
 */
export async function containerReadVerdict(nestId: string, nodeId: string, userId: string): Promise<boolean | null> {
  if (isConversationId(nodeId)) return isContainerMember(nestId, nodeId, userId);
  if (isChannelId(nodeId) && (await isPrivateContainer(nestId, nodeId))) return isContainerMember(nestId, nodeId, userId);
  return null;
}

/**
 * Among these node ids, the private containers this caller is NOT a member
 * of (so a listing drops them). Only ids under nodes/channels/ and
 * nodes/conversations/ are looked at; two small queries however many nodes.
 */
export async function hiddenContainersFor(nestId: string, userId: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.some((id) => isChannelId(id) || isConversationId(id))) return out;
  const priv = await privateContainerIds(nestId);
  const mine = priv.size ? await memberContainers(nestId, userId) : new Set<string>();
  for (const id of ids) if ((priv.has(id) || isConversationId(id)) && !mine.has(id)) out.add(id);
  return out;
}

/** The conversation documents of a nest (the cached listing). */
export async function conversationDocs(nestId: string): Promise<ContextNode[]> {
  const { storage } = await engineCache.get(nestId);
  return (await storage.discoverDocuments()).filter(isConversationDoc) as ContextNode[];
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
