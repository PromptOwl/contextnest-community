/**
 * What a channel or thread message carries beyond its text (PO-1189/PO-1190):
 * the author's display name, which `@names` in it resolved, and who wrote it
 * when an agent did.
 *
 * Three small rules live here so REST, MCP, My Work and promote agree:
 *
 *   - Names. `resolveActorLabel` (actor-label.ts, the identity seam) answers
 *     in emails; `namedActor` swaps in the person's display name without
 *     changing the seam's label format.
 *
 *   - A key label is not an agent (AC-AX-12). The transport derives
 *     `client.agent` from the API key's label when the caller says nothing
 *     (shared/client-metadata.ts), which made every personal key read as
 *     "<label>, on behalf of <person>". A MESSAGE row now keeps `agent` only
 *     when the caller declared it (the call's own `client.agent`, or the MCP
 *     handshake's client name); a label that came from the key alone is
 *     stored beside it as `key_label`. API keys carry no "this is an agent"
 *     mark today, so declaring is the only way to show as one.
 *
 *   - Who an `@name` is. A person (the nest roster, then the directory, by
 *     the same rule mention-notify uses), a known agent (a handle with a
 *     wake-up target, or one that has posted in this nest's channels as a
 *     declared agent), or nobody.
 */
import { getDb } from "../db/client.js";
import { listNestPeople, findDirectoryPerson, type NestPerson } from "../nests/people-service.js";
import { extractMentions, resolveMention } from "../shared/mentions.js";
import { deserializeClient, parseClientMetadata, type ClientMetadata } from "../shared/client-metadata.js";
import { resolveActorLabel, type ActorLabel } from "./actor-label.js";

// ─── Display names ──────────────────────────────────────────────────────

/** Lowercased email → display name, for the emails that have one. */
export async function displayNames(emails: Iterable<string>): Promise<Map<string, string>> {
  const wanted = [...new Set([...emails].map((e) => String(e ?? "").toLowerCase()).filter(Boolean))];
  const out = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += 200) {
    const chunk = wanted.slice(i, i + 200);
    const rows = (await getDb().all(
      `SELECT LOWER(email) AS email, name FROM users WHERE LOWER(email) IN (${chunk.map(() => "?").join(", ")})`,
      chunk,
    )) as Array<{ email: string; name: string | null }>;
    for (const r of rows) if (r.name?.trim()) out.set(r.email, r.name.trim());
  }
  return out;
}

/** The actor for a message, with the person shown by display name. */
export async function namedActor(
  email: string,
  client: ClientMetadata | undefined,
  names: Map<string, string>,
): Promise<{ actor: ActorLabel; name: string }> {
  const actor = await resolveActorLabel({ email, client });
  const name = names.get(String(email ?? "").toLowerCase()) ?? email;
  // Only when the seam answered with the email: an identity layer that already
  // names the person keeps its own answer.
  if (name === email || actor.human !== email) return { actor, name };
  return { actor: { ...actor, human: name, label: actor.label.replace(email, name) }, name };
}

// ─── Who wrote it ───────────────────────────────────────────────────────

export function normHandle(raw: unknown): string {
  return String(raw ?? "").trim().replace(/^@/, "").toLowerCase();
}

/**
 * The attribution a message row stores: `agent` only when the caller declared
 * one; a label that is merely the API key's is kept as `key_label`.
 *
 * `merged` is what the transport resolved (attributeRequest / the MCP tool
 * context), `supplied` the call's own raw `client`, `keyLabel` the key's label.
 */
export function messageClient(
  merged: ClientMetadata | undefined,
  supplied: unknown,
  keyLabel: string | null | undefined,
): ClientMetadata | undefined {
  if (!merged?.agent || !keyLabel) return merged;
  let declared: string | undefined;
  try {
    declared = parseClientMetadata(supplied)?.agent;
  } catch {
    declared = undefined;
  }
  if (declared) return merged;
  if (!String(keyLabel).startsWith(merged.agent)) return merged; // the handshake's name, or the server's own
  const { agent, ...rest } = merged;
  return { ...rest, key_label: agent } as ClientMetadata;
}

/** The handles a message's writer answers to: the declared agent and the key
 *  label, lowercased. Empty for a person in the browser. */
export function writerHandles(client: ClientMetadata | undefined | null): string[] {
  const c = (client ?? {}) as Record<string, unknown>;
  return [...new Set([normHandle(c.agent), normHandle(c.key_label)].filter(Boolean))];
}

export function writerHandlesOf(clientJson: string | null | undefined): string[] {
  return writerHandles(deserializeClient(clientJson));
}

// ─── Known agents ───────────────────────────────────────────────────────

const AGENT_HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** Most channel messages scanned for declared agent labels (newest first). */
const SEEN_SCAN = 2000;
const MAX_KNOWN_AGENTS = 100;

export interface KnownAgent {
  handle: string;
  /** An @mention of it sends a wake-up POST. False: it finds the mention in
   *  its own `context_my_work`. */
  wakeable: boolean;
}

/**
 * The agent handles this nest knows: every handle with a wake-up target, plus
 * every declared agent label seen on a message in the nest's channels. Never
 * a target, never a key label.
 */
export async function knownAgents(nestId: string): Promise<KnownAgent[]> {
  const db = getDb();
  const [hooks, seen] = await Promise.all([
    db.all("SELECT handle FROM agent_webhooks WHERE nest_id = ? ORDER BY handle", [nestId]) as Promise<Array<{ handle: string }>>,
    db.all(
      `SELECT c.client_json FROM annotation_comments c
         JOIN annotation_threads t ON t.id = c.thread_id
        WHERE t.nest_id = ? AND t.node_id LIKE 'nodes/channels/%' AND c.client_json LIKE '%"agent"%'
        ORDER BY c.created_at DESC
        LIMIT ${SEEN_SCAN}`,
      [nestId],
    ) as Promise<Array<{ client_json: string | null }>>,
  ]);
  const handles = new Set<string>(hooks.map((h) => normHandle(h.handle)));
  for (const r of seen) {
    const h = normHandle(deserializeClient(r.client_json)?.agent);
    if (AGENT_HANDLE_RE.test(h)) handles.add(h);
  }
  const { agentWakeTarget } = await import("../stream/agent-wake.js");
  const list = [...handles].filter(Boolean).sort().slice(0, MAX_KNOWN_AGENTS);
  return Promise.all(list.map(async (handle) => ({ handle, wakeable: (await agentWakeTarget(nestId, handle)) !== null })));
}

// ─── Mentions in a body ─────────────────────────────────────────────────

export type MentionRef =
  | { name: string; kind: "person"; display_name: string }
  | { name: string; kind: "agent"; wakeable: boolean }
  | { name: string; kind: "nobody" };

export interface ResolvedMention {
  name: string;
  person?: NestPerson;
  agent?: KnownAgent;
}

/**
 * Resolve every `@name` in each body, in order of appearance. Loads the
 * roster once, and the known agents only when some name is not a person;
 * bodies with no mention cost nothing.
 */
export async function resolveBodyMentions(nestId: string, bodies: string[]): Promise<ResolvedMention[][]> {
  const names = bodies.map((b) => extractMentions(b || ""));
  if (names.every((n) => n.length === 0)) return names.map(() => []);
  const roster = await listNestPeople(nestId);
  const people = new Map<string, NestPerson | undefined>();
  for (const name of new Set(names.flat().map((n) => n.toLowerCase()))) {
    people.set(name, resolveMention(roster, name) ?? (await findDirectoryPerson(name)));
  }
  let agents: Map<string, KnownAgent> | undefined;
  const out: ResolvedMention[][] = [];
  for (const list of names) {
    const row: ResolvedMention[] = [];
    for (const name of list) {
      const person = people.get(name.toLowerCase());
      if (person) {
        row.push({ name, person });
        continue;
      }
      agents ??= new Map((await knownAgents(nestId)).map((a) => [a.handle, a]));
      const agent = agents.get(normHandle(name));
      row.push(agent ? { name, agent } : { name });
    }
    out.push(row);
  }
  return out;
}

export function toMentionRef(m: ResolvedMention): MentionRef {
  if (m.person) return { name: m.name, kind: "person", display_name: m.person.name?.trim() || m.person.email };
  if (m.agent) return { name: m.name, kind: "agent", wakeable: m.agent.wakeable };
  return { name: m.name, kind: "nobody" };
}

/** `mentions` for each body, as a timeline shows them. */
export async function bodyMentions(nestId: string, bodies: string[]): Promise<MentionRef[][]> {
  return (await resolveBodyMentions(nestId, bodies)).map((row) => row.map(toMentionRef));
}
