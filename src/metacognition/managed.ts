/**
 * A Slack listener is an agent record the server creates for a channel binding
 * (surfaces/services/listener-service.ts). A generic save drops its tie to the
 * binding and a delete leaves the binding pointing at nothing; either stops
 * capture. So it is read-only here while a live binding names it.
 */
import { getDb } from "../db/client.js";
import { ConflictError } from "../shared/errors.js";
import type { MetacognitionAgent } from "./store.js";

export const MANAGED_BY_SLACK =
  "This listener is managed by Slack setup. A server admin can change it in Control room → Setup.";

export interface ManagedBy {
  kind: "slack";
  /** Null for a direct message, or when the name isn't known. */
  channel: string | null;
  /** The binding's status: active, paused_guard or paused_by_member. */
  status: string;
}

/** The nest's live listeners, by agent node id. */
export async function managedAgents(nestId: string): Promise<Map<string, ManagedBy>> {
  const rows = (await getDb().all(
    `SELECT listener_agent_node_id AS node_id, conversation_kind, conversation_name, status
       FROM surface_bindings
      WHERE nest_id = ? AND listener_agent_node_id IS NOT NULL AND status <> 'removed'`,
    [nestId],
  )) as Array<{ node_id: string; conversation_kind: string; conversation_name: string | null; status: string }>;
  return new Map(
    rows.map((r) => [r.node_id, { kind: "slack", channel: r.conversation_kind === "dm" ? null : r.conversation_name, status: r.status }]),
  );
}

export async function assertNotManaged(nestId: string, nodeId: string): Promise<void> {
  if ((await managedAgents(nestId)).has(nodeId)) throw new ConflictError(MANAGED_BY_SLACK);
}

/** The folders a listener proposes into (set by the starter), for display. */
export function listenerFoldersView(a: MetacognitionAgent): string[] {
  const f = (a.config as { surfaces_listener?: { folders?: unknown } }).surfaces_listener?.folders;
  return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [];
}
