/**
 * The binding's listener (carry-forward 2): a metacognition agent the SERVER
 * creates for each binding, recorded on the binding at creation, never named
 * by a client. It is the judge's identity: it reads the bound nest's starter
 * folders and is the proposer of record on every Surfaces proposal.
 *
 * It is stored switched OFF for the generic metacognition runner, so a
 * schedule, hook or Run button can never give it the write tools; only the
 * restricted judge (judge-service.ts) runs it. Its config carries
 * `surfaces_listener.binding_id`; readers.ts exempts it only while that tie
 * holds (the binding row names this exact agent).
 */
import { randomBytes } from "crypto";
import { getDb } from "../../db/client.js";
import { upsertAgent, getAgent, deleteAgent, type MetacognitionAgent } from "../../metacognition/store.js";
import type { MetacognitionConfig } from "../../metacognition/config.js";
import { ROOT_FOLDER } from "../core/judge-schema.js";
import { isTiedListenerConfig } from "../core/listener-tie.js";
import { createBinding, getBindingRow, bindingView, type BindInput } from "./binding-service.js";

export const LISTENER_NAME = "Nest listener";
/**
 * Default folders a listener proposes into: NONE (spec §13 / AC-SEED-09).
 * Surfaces never names a folder; what a nest's listener may propose into is
 * nest data, set when a seed is applied (`setListenerFolders`). A binding with
 * no folders ends every window as `no_target_folder`, with an admin alert.
 */
export const DEFAULT_LISTENER_FOLDERS: readonly string[] = [];

export interface SurfacesListenerMarker {
  binding_id: string;
  /** Target folders ("/" = root). */
  folders: string[];
  /** Folders whose drafts are people facts (role/owns/contact/team). */
  people_folders: string[];
}

export type ListenerConfig = MetacognitionConfig & { surfaces_listener: SurfacesListenerMarker };

export function listenerConfig(bindingId: string, folders: readonly string[] = DEFAULT_LISTENER_FOLDERS): ListenerConfig {
  return {
    persona: { name: LISTENER_NAME, avatar: null },
    // The generic scope is wide on purpose and never used by the generic
    // runner (the agent is switched off); the judge enforces the folders
    // in surfaces_listener on every read and every proposal.
    scope: { read: [], propose: ["*"] },
    caps: { max_steps: 4, max_tokens: 17_500, max_seconds: 120, max_proposals: 3, max_comments: 0 },
    feeds: [],
    mcp_servers: [],
    model: null,
    notify: { recipients: [], channels: [], max_per_run: 1 },
    surfaces_listener: { binding_id: bindingId, folders: [...folders], people_folders: [] },
  };
}

/** The listener's folders, sanitised; the default when unset or malformed. */
export function listenerFolders(agent: MetacognitionAgent): { folders: string[]; people: string[] } {
  const m = (agent.config as Partial<ListenerConfig>).surfaces_listener;
  const ok = (f: unknown): f is string => typeof f === "string" && (f === ROOT_FOLDER || /^[a-z0-9][a-z0-9_-]{0,60}\/$/i.test(f));
  const folders = Array.isArray(m?.folders) && m!.folders.every(ok) ? [...m!.folders] : [...DEFAULT_LISTENER_FOLDERS];
  const people = Array.isArray(m?.people_folders) ? m!.people_folders.filter((f) => ok(f) && folders.includes(f)) : [];
  return { folders, people };
}

/** Is this agent the server-created listener of exactly this binding? */
export function isListenerOf(agent: MetacognitionAgent | null, bindingId: string): agent is MetacognitionAgent {
  return !!agent && isTiedListenerConfig(agent.config, agent.enabled, bindingId);
}

/**
 * Create the listener for a binding that has none and record it. The id is
 * written on the binding first (compare-and-set on a NULL listener), then the
 * agent row — so there is never an agent on the nest that isn't yet tied.
 */
export async function ensureListener(bindingId: string, actorEmail: string): Promise<string | null> {
  const row = await getBindingRow(bindingId);
  if (!row) return null;
  if (row.listener_agent_node_id) return row.listener_agent_node_id;
  const nodeId = `nodes/nest-listener-${randomBytes(4).toString("hex")}`;
  const r = await getDb().run("UPDATE surface_bindings SET listener_agent_node_id = ?, updated_at = ? WHERE id = ? AND listener_agent_node_id IS NULL", [
    nodeId,
    new Date().toISOString(),
    bindingId,
  ]);
  if (r.changes === 0) return (await getBindingRow(bindingId))?.listener_agent_node_id ?? null;
  await upsertAgent({ nestId: row.nest_id, nodeId, config: listenerConfig(bindingId), enabled: false, savedBy: actorEmail });
  return nodeId;
}

export async function listenerFor(bindingId: string): Promise<MetacognitionAgent | null> {
  const row = await getBindingRow(bindingId);
  if (!row?.listener_agent_node_id) return null;
  const agent = await getAgent(row.nest_id, row.listener_agent_node_id);
  return isListenerOf(agent, bindingId) ? agent : null;
}

/** Create a binding the way every surface route does: guard, then its listener. */
export async function createBindingWithListener(input: Omit<BindInput, "listenerAgentNodeId">) {
  const out = await createBinding({ ...input, listenerAgentNodeId: null });
  const u = (await getDb().get("SELECT email FROM users WHERE id = ?", [input.actorUserId])) as { email?: string } | undefined;
  if (u?.email) await ensureListener(out.binding.id, u.email);
  const row = await getBindingRow(out.binding.id);
  return { ...out, binding: row ? await bindingView(row) : out.binding };
}

/** Remove a removed binding's listener agent and untie it from the row. */
export async function removeListener(bindingId: string): Promise<void> {
  const row = await getBindingRow(bindingId);
  if (!row?.listener_agent_node_id) return;
  const agent = await getAgent(row.nest_id, row.listener_agent_node_id);
  if (isListenerOf(agent, bindingId)) await deleteAgent(row.nest_id, row.listener_agent_node_id);
  await getDb().run("UPDATE surface_bindings SET listener_agent_node_id = NULL WHERE id = ? AND status = 'removed' AND listener_agent_node_id = ?", [
    bindingId,
    row.listener_agent_node_id,
  ]);
}

const FOLDER_RE = /^[a-z0-9][a-z0-9_-]{0,60}\/$/i;

/**
 * Set the folders a binding's listener proposes into (and which of them hold
 * people facts). Called by a seed when it is applied (S3) — the only way a
 * listener gets folders. "/" is the nest root. Keeps the server tie intact.
 */
export async function setListenerFolders(bindingId: string, folders: string[], peopleFolders: string[] = []): Promise<void> {
  const ok = (f: unknown): f is string => typeof f === "string" && (f === ROOT_FOLDER || FOLDER_RE.test(f));
  if (!folders.every(ok) || !peopleFolders.every((f) => ok(f) && folders.includes(f))) throw new Error("invalid listener folders");
  const row = await getBindingRow(bindingId);
  if (!row?.listener_agent_node_id) throw new Error("binding has no listener");
  const agent = await getAgent(row.nest_id, row.listener_agent_node_id);
  if (!isListenerOf(agent, bindingId)) throw new Error("binding has no listener");
  const cfg = agent.config as ListenerConfig;
  const next = { ...cfg, surfaces_listener: { ...cfg.surfaces_listener, folders: [...new Set(folders)], people_folders: [...new Set(peopleFolders)] } };
  await getDb().run("UPDATE metacognition_agents SET config_json = ?, updated_at = ? WHERE nest_id = ? AND node_id = ? AND enabled = 0", [
    JSON.stringify(next),
    new Date().toISOString(),
    row.nest_id,
    row.listener_agent_node_id,
  ]);
}
