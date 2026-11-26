/**
 * A Slack listener is an agent record the server creates for a channel binding
 * (surfaces/services/listener-service.ts). A generic save drops its tie to the
 * binding and a delete leaves the binding pointing at nothing; either stops
 * capture. So it is read-only here while a live binding names it.
 */
import { getDb } from "../db/client.js";
import { ConflictError } from "../shared/errors.js";
import { DEFAULT_LISTENER_NAME } from "../surfaces/services/judge-tuning.js";
import type { MetacognitionAgent } from "./store.js";

export const MANAGED_BY_SLACK =
  "This listener is managed by Slack setup. A server admin can change it in Control room → Setup.";

/**
 * What a listener is called: the name an admin gave it, else its channel, so
 * several listeners on one nest can be told apart. Read live, so a renamed
 * channel shows its new name. Null = no better name than its node id.
 */
export function listenerName(custom: string | null, channel: string | null, nodeId: string): string | null {
  if (custom && custom !== DEFAULT_LISTENER_NAME) return custom;
  return channel ? `${channel} nest agent ${nodeId.split("-").pop()}` : null;
}

export interface ManagedBy {
  kind: "slack";
  /** Its display name (`listenerName`). */
  name: string | null;
  /** Null for a direct message, or when the name isn't known. */
  channel: string | null;
  /** The binding's status: active, paused_guard or paused_by_member. */
  status: string;
}

/** The nest's live listeners, by agent node id. */
export async function managedAgents(nestId: string): Promise<Map<string, ManagedBy>> {
  const rows = (await getDb().all(
    `SELECT b.listener_agent_node_id AS node_id, b.conversation_kind, b.conversation_name, b.status, u.name AS persona_name
       FROM surface_bindings b
       LEFT JOIN metacognition_agents m ON m.nest_id = b.nest_id AND m.node_id = b.listener_agent_node_id
       LEFT JOIN users u ON u.id = m.persona_user_id
      WHERE b.nest_id = ? AND b.listener_agent_node_id IS NOT NULL AND b.status <> 'removed'`,
    [nestId],
  )) as Array<{ node_id: string; conversation_kind: string; conversation_name: string | null; status: string; persona_name: string | null }>;
  return new Map(
    rows.map((r) => {
      const channel = r.conversation_kind === "dm" ? null : r.conversation_name;
      return [r.node_id, { kind: "slack", name: listenerName(r.persona_name, channel, r.node_id), channel, status: r.status }];
    }),
  );
}

const PERSONA_DOMAIN = "@agents.invalid";
export const isPersonaEmail = (email: string | null | undefined): email is string => !!email?.toLowerCase().endsWith(PERSONA_DOMAIN);

/**
 * What people call the agents behind these addresses. A persona signs its work
 * with an internal address (metacognition/store.ts) that means nothing to a
 * reader. No query when there is no persona in the list.
 */
export async function personaNames(emails: Array<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(emails.filter(isPersonaEmail))];
  const out = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500);
    const rows = (await getDb().all(
      `SELECT u.email, u.name, m.node_id, b.conversation_name, b.conversation_kind
         FROM users u
         LEFT JOIN metacognition_agents m ON m.persona_user_id = u.id
         LEFT JOIN surface_bindings b ON b.nest_id = m.nest_id AND b.listener_agent_node_id = m.node_id AND b.status <> 'removed'
        WHERE u.is_service = 1 AND u.email IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    )) as Array<{ email: string; name: string | null; node_id: string | null; conversation_name: string | null; conversation_kind: string | null }>;
    for (const r of rows) {
      const name = (r.node_id && r.conversation_kind ? listenerName(r.name, r.conversation_kind === "dm" ? null : r.conversation_name, r.node_id) : null) ?? r.name;
      if (name) out.set(r.email, name);
    }
  }
  return out;
}

export async function assertNotManaged(nestId: string, nodeId: string): Promise<void> {
  if ((await managedAgents(nestId)).has(nodeId)) throw new ConflictError(MANAGED_BY_SLACK);
}

/** The folders a listener proposes into (set by the starter), for display. */
export function listenerFoldersView(a: MetacognitionAgent): string[] {
  const f = (a.config as { surfaces_listener?: { folders?: unknown } }).surfaces_listener?.folders;
  return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [];
}
