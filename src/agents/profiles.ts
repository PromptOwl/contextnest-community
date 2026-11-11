/**
 * Agent profiles (C7, PO-1198): what an agent is, when it was last seen,
 * what it did and what it knows — a QUERY over what the server already
 * records, plus one admin-set description.
 *
 *   what it is    the handles the nest knows (channels/message-meta.ts
 *                 knownAgents: a wake-up target, or a declared `client.agent`
 *                 seen on a channel message) and Hootie while it is on;
 *                 kind `webhook` (agent_webhooks row), `key` (declared only)
 *                 or `hootie`; `owner` = who saved the webhook, else who the
 *                 agent last wrote on behalf of.
 *   presence      the newest channel message that carries its handle.
 *   what it did   its last N channel messages (in channels the caller can
 *                 read), the review requests it filed (proposals), the nodes
 *                 it authored that came from a thread (promotes).
 *   what it knows the nodes it authored or proposed, bounded, only the ones
 *                 the caller can read (filterAccessible).
 *   wake-up       whether a mention wakes it, and its last delivery — as the
 *                 webhooks panel shows them, without the target.
 *
 * Members only; a non-member and an unknown handle get the same NotFound.
 * The description (≤500 chars) is the one stored thing: `agent_profiles`
 * (migration 091), set by the nest owner or an admin.
 */
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { filterAccessible } from "../governance/access-guard.js";
import { resolveNestAccess } from "../shared/access.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { deserializeClient, type ClientMetadata } from "../shared/client-metadata.js";
import { isNestMember } from "../channels/channel-service.js";
import { isChannelDoc } from "../channels/channel-node.js";
import { engineCache } from "../nodes/engine.js";
import { knownAgents, normHandle, writerHandles } from "../channels/message-meta.js";
import { agentWakeTarget, lastDeliveries, type DeliveryView } from "../stream/agent-wake.js";
import { effectiveHootieBrand } from "../hootie/brand.js";
import { HOOTIE_HANDLE, isReservedHandle } from "./reserved.js";

export const MAX_DESCRIPTION = 500;
const MAX_DID = 20;
const MAX_KNOWS = 50;
/** Most channel messages scanned for an agent's activity (newest first). */
const SCAN = 2000;
const EXCERPT = 140;

export interface AgentSummary {
  handle: string;
  /** What the handle shows as (the brand name for Hootie). */
  name: string;
  kind: "hootie" | "webhook" | "key";
  /** Who saved its webhook, else the person it last wrote on behalf of; null for Hootie. */
  owner: string | null;
  description: string | null;
  /** When it last posted in a channel (stored form), or null. */
  last_seen_at: string | null;
  /** Channel messages it wrote (bounded by the scan). */
  message_count: number;
  wake: { wakeable: boolean; last_delivery: DeliveryView | null };
}

export interface AgentProfile extends AgentSummary {
  did: {
    messages: Array<{ id: string; thread_id: string; node_id: string; channel: string | null; created_at: string; excerpt: string }>;
    proposals: Array<{ review_id: string; node_id: string; title: string | null; version: number; status: string; requested_at: string }>;
    promotes: Array<{ id: string; title: string }>;
  };
  knows: Array<{ id: string; title: string; type: string; status: string }>;
}

interface Caller {
  nestId: string;
  userId: string;
  userEmail: string;
}

interface Row {
  id: string;
  thread_id: string;
  node_id: string;
  author: string;
  body: string;
  created_at: string;
  client_json: string | null;
}

/** The newest channel messages that carry an agent handle, by handle. */
async function activity(nestId: string): Promise<Map<string, Row[]>> {
  const rows = (await getDb().all(
    `SELECT c.id, c.thread_id, t.node_id, c.author, c.body, c.created_at, c.client_json
       FROM annotation_comments c
       JOIN annotation_threads t ON t.id = c.thread_id
      WHERE t.nest_id = ? AND t.node_id LIKE 'nodes/channels/%' AND c.client_json IS NOT NULL
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${SCAN}`,
    [nestId],
  )) as Row[];
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const client = deserializeClient(r.client_json) as Record<string, unknown> | undefined;
    if (!client) continue;
    const handles = client.model_answer === true ? [HOOTIE_HANDLE] : writerHandles(client as unknown as ClientMetadata).filter((h) => !isReservedHandle(h));
    for (const h of handles) {
      const list = out.get(h) ?? [];
      list.push(r);
      out.set(h, list);
    }
  }
  return out;
}

async function descriptions(nestId: string): Promise<Map<string, string>> {
  const rows = (await getDb().all("SELECT handle, description FROM agent_profiles WHERE nest_id = ?", [nestId])) as Array<{ handle: string; description: string }>;
  return new Map(rows.map((r) => [r.handle, r.description]));
}

/** The channel nodes this caller may read: every presence or activity figure
 *  is computed over these only (security review r2 F11). */
async function readableChannels(caller: Caller): Promise<Set<string>> {
  const { storage } = await engineCache.get(caller.nestId);
  const channels = (await storage.discoverDocuments()).filter(isChannelDoc);
  return new Set((await filterAccessible(caller.nestId, caller.userId, caller.userEmail, channels)).map((d) => d.id));
}

async function summaries(caller: Caller, readable?: Set<string>): Promise<Map<string, AgentSummary>> {
  const { nestId } = caller;
  const [known, hooks, deliveries, acts, descs, ok] = await Promise.all([
    knownAgents(nestId),
    getDb().all("SELECT handle, created_by FROM agent_webhooks WHERE nest_id = ?", [nestId]) as Promise<Array<{ handle: string; created_by: string }>>,
    lastDeliveries(nestId),
    activity(nestId),
    descriptions(nestId),
    readable ?? readableChannels(caller),
  ]);
  const hookBy = new Map(hooks.map((h) => [normHandle(h.handle), h.created_by]));
  const out = new Map<string, AgentSummary>();
  const summary = (handle: string, kind: AgentSummary["kind"], wakeable: boolean): AgentSummary => {
    const rows = (acts.get(handle) ?? []).filter((r) => ok.has(r.node_id));
    const newest = rows[0];
    return {
      handle,
      name: kind === "hootie" ? effectiveHootieBrand().name : handle,
      kind,
      owner: kind === "hootie" ? null : (hookBy.get(handle) ?? newest?.author ?? null),
      description: descs.get(handle) ?? null,
      last_seen_at: newest?.created_at ?? null,
      message_count: rows.length,
      wake: { wakeable, last_delivery: deliveries.get(handle) ?? null },
    };
  };
  if (config.HOOTIE_ENABLED) out.set(HOOTIE_HANDLE, summary(HOOTIE_HANDLE, "hootie", false));
  for (const a of known) out.set(a.handle, summary(a.handle, hookBy.has(a.handle) ? "webhook" : "key", a.wakeable));
  return out;
}

export async function listAgents(caller: Caller): Promise<{ agents: AgentSummary[] }> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Not found");
  const all = await summaries(caller);
  return { agents: [...all.values()].sort((a, b) => (a.kind === "hootie" ? -1 : b.kind === "hootie" ? 1 : a.handle.localeCompare(b.handle))) };
}

export async function getAgent(caller: Caller, rawHandle: unknown): Promise<{ agent: AgentProfile }> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Not found");
  const handle = normHandle(rawHandle);
  const readable = await readableChannels(caller);
  const all = await summaries(caller, readable);
  const base = all.get(handle);
  if (!base) throw new NotFoundError("Agent not found");
  const { nestId } = caller;
  const db = getDb();

  // Did: messages, in channels this caller can read.
  const rows = (await activity(nestId)).get(handle) ?? [];
  const messages = rows
    .filter((r) => readable.has(r.node_id))
    .slice(0, MAX_DID)
    .map((r) => {
      const flat = r.body.replace(/\s+/g, " ").trim();
      return {
        id: r.id,
        thread_id: r.thread_id,
        node_id: r.node_id,
        channel: r.node_id.split("/").pop() ?? null,
        created_at: r.created_at,
        excerpt: flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat,
      };
    });

  // Did: the review requests it filed (its proposals), newest first.
  const reviews = (await db.all(
    `SELECT r.id, r.node_id, r.version, r.status, r.requested_at, ni.title
       FROM review_requests r
       LEFT JOIN node_index ni ON ni.nest_id = r.nest_id AND ni.node_id = r.node_id
      WHERE r.nest_id = ? AND LOWER(r.requested_by) = ?
      ORDER BY r.requested_at DESC
      LIMIT ${MAX_DID}`,
    [nestId, handle],
  )) as Array<{ id: string; node_id: string; version: number; status: string; requested_at: string; title: string | null }>;

  // Knows: nodes it authored (as the version author, or declared on the
  // version's attribution) plus the ones it proposed — only what the caller
  // can read.
  const authored = (await db.all(
    `SELECT DISTINCT node_id FROM node_versions
      WHERE nest_id = ? AND (LOWER(author) = ? OR client_json LIKE ? ESCAPE '\\')
      ORDER BY node_id
      LIMIT ${MAX_KNOWS * 4}`,
    [nestId, handle, `%"agent":"${handle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}"%`],
  )) as Array<{ node_id: string }>;
  const candidates = [...new Set([...authored.map((r) => r.node_id), ...reviews.map((r) => r.node_id)])];
  const ok = new Set((await filterAccessible(nestId, caller.userId, caller.userEmail, candidates.map((id) => ({ id })))).map((n) => n.id));
  const meta = candidates.length
    ? ((await db.all(
        `SELECT node_id, title, type, status, frontmatter_json FROM node_index WHERE nest_id = ? AND node_id IN (${candidates.map(() => "?").join(", ")})`,
        [nestId, ...candidates],
      )) as Array<{ node_id: string; title: string; type: string; status: string; frontmatter_json: string }>)
    : [];
  const knows = meta
    .filter((m) => ok.has(m.node_id))
    .slice(0, MAX_KNOWS)
    .map((m) => ({ id: m.node_id, title: m.title || m.node_id, type: m.type, status: m.status }));
  const promotes = meta
    .filter((m) => ok.has(m.node_id) && authored.some((a) => a.node_id === m.node_id) && m.frontmatter_json.includes('"source_thread"'))
    .slice(0, MAX_DID)
    .map((m) => ({ id: m.node_id, title: m.title || m.node_id }));
  const proposals = reviews
    .filter((r) => ok.has(r.node_id))
    .map((r) => ({ review_id: r.id, node_id: r.node_id, title: r.title, version: Number(r.version), status: r.status, requested_at: r.requested_at }));

  return { agent: { ...base, did: { messages, proposals, promotes }, knows } };
}

/** Owner or admin sets the one stored thing about an agent: its description. */
export async function setAgentDescription(caller: Caller, rawHandle: unknown, raw: unknown): Promise<{ agent: AgentSummary }> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Not found");
  if (config.AUTH_MODE !== "open") {
    const access = await resolveNestAccess(caller.nestId, caller.userId);
    if (access.rawPermission !== "owner" && access.rawPermission !== "admin") {
      throw new ForbiddenError("Only a nest owner or admin can describe an agent.");
    }
    if (access.archived) throw new ForbiddenError("This nest is archived, so it is read-only.");
  }
  if (raw !== null && typeof raw !== "string") throw new ValidationError("description must be a string (empty or null clears it)");
  const description = String(raw ?? "").trim();
  if (description.length > MAX_DESCRIPTION) throw new ValidationError(`description is at most ${MAX_DESCRIPTION} characters`);
  const handle = normHandle(rawHandle);
  const all = await summaries(caller);
  if (!all.has(handle)) throw new NotFoundError("Agent not found");
  const db = getDb();
  if (!description) {
    await db.run("DELETE FROM agent_profiles WHERE nest_id = ? AND handle = ?", [caller.nestId, handle]);
  } else {
    await db.run(
      `INSERT INTO agent_profiles (nest_id, handle, description, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (nest_id, handle) DO UPDATE SET description = excluded.description, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [caller.nestId, handle, description, caller.userEmail, new Date().toISOString()],
    );
  }
  return { agent: (await summaries(caller)).get(handle)! };
}

/** The agent's wake-up status, for a profile the caller may already hold. */
export async function wakeStatus(nestId: string, handle: string): Promise<boolean> {
  return (await agentWakeTarget(nestId, handle)) !== null;
}

/** Plain text for an agent list, for an MCP tool. */
export function agentsText(agents: AgentSummary[]): string {
  if (agents.length === 0) return "No agents known in this nest yet.";
  return `# Agents (${agents.length})\n\n${agents
    .map(
      (a) =>
        `- @${a.handle} (${a.kind}${a.owner ? `, ${a.owner}` : ""})${a.description ? ` — ${a.description}` : ""}${
          a.last_seen_at ? ` · last seen ${a.last_seen_at}` : " · never posted"
        }${a.wake.wakeable ? " · woken by a mention" : ""}`,
    )
    .join("\n")}\n\nDetails: context_agents { handle }.`;
}

export function agentText(a: AgentProfile): string {
  const lines = [
    `# @${a.handle} — ${a.name} (${a.kind})`,
    a.description ? a.description : "(no description)",
    `Owner: ${a.owner ?? "—"} · last seen: ${a.last_seen_at ?? "never"} · messages: ${a.message_count} · wake-up: ${a.wake.wakeable ? "yes" : "no"}${
      a.wake.last_delivery ? ` (last ${a.wake.last_delivery.status} at ${a.wake.last_delivery.at})` : ""
    }`,
    "",
    `## Did`,
    ...(a.did.messages.length ? a.did.messages.map((m) => `- [${m.created_at}] #${m.channel} thread ${m.thread_id}: ${m.excerpt}`) : ["- no messages"]),
    ...(a.did.proposals.length ? a.did.proposals.map((p) => `- proposed ${p.title ?? p.node_id} v${p.version} (${p.status})`) : []),
    ...(a.did.promotes.length ? a.did.promotes.map((p) => `- promoted ${p.title} (${p.id})`) : []),
    "",
    `## Knows`,
    ...(a.knows.length ? a.knows.map((n) => `- ${n.title} (${n.id}) [${n.type}, ${n.status}]`) : ["- nothing it authored or proposed that you can read"]),
  ];
  return lines.join("\n");
}
