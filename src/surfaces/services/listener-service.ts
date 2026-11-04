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
  /** §13, from the applied seed's manifest.listener: tags offered to the judge. */
  domain_tags?: string[];
  /** §13: categories added to the judge's must-never list. */
  never_propose?: string[];
  /** S7-R2 L5: the seed's plain-word synonyms for those categories. */
  never_terms?: string[];
  /** §13: folders only nest admins may approve into (the seed's admin_only). */
  admin_folders?: string[];
  /** §13: the seed's thesis document, read by the judge as its north star. */
  thesis_node_id?: string | null;
}

/** The seed-derived listener settings beyond the folders. */
export interface ListenerSeedSettings {
  domainTags?: string[];
  neverPropose?: string[];
  neverTerms?: string[];
  adminFolders?: string[];
  thesisNodeId?: string | null;
}
const TERM = /^[\p{L}\p{N}][\p{L}\p{N}' -]{0,59}$/u;
const terms = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && TERM.test(x)))] : []);

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

const SLUG = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const slugs = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && SLUG.test(x)))] : []);

/** The listener's folders (and seed settings), sanitised; the default when unset or malformed. */
export function listenerFolders(agent: MetacognitionAgent): {
  folders: string[];
  people: string[];
  domainTags: string[];
  neverPropose: string[];
  neverTerms: string[];
  adminFolders: string[];
  thesisNodeId: string | null;
} {
  const m = (agent.config as Partial<ListenerConfig>).surfaces_listener;
  const ok = (f: unknown): f is string => typeof f === "string" && (f === ROOT_FOLDER || /^[a-z0-9][a-z0-9_-]{0,60}\/$/i.test(f));
  const folders = Array.isArray(m?.folders) && m!.folders.every(ok) ? [...m!.folders] : [...DEFAULT_LISTENER_FOLDERS];
  const people = Array.isArray(m?.people_folders) ? m!.people_folders.filter((f) => ok(f) && folders.includes(f)) : [];
  const adminFolders = Array.isArray(m?.admin_folders) ? m!.admin_folders.filter((f) => typeof f === "string" && FOLDER_PATH_RE.test(f)) : [];
  const thesis = typeof m?.thesis_node_id === "string" && /^nodes\/[a-z0-9][a-z0-9/_-]{0,300}$/.test(m.thesis_node_id) && !m.thesis_node_id.includes("..") ? m.thesis_node_id : null;
  return { folders, people, domainTags: slugs(m?.domain_tags), neverPropose: slugs(m?.never_propose), neverTerms: terms(m?.never_terms), adminFolders, thesisNodeId: thesis };
}
const FOLDER_PATH_RE = /^(?:[a-z0-9][a-z0-9_-]{0,60}\/){1,4}$/;

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
  // §13: a binding on a seeded nest proposes into that seed's folders from the start.
  const { configureListenerFromSeeds } = await import("./seed-service.js");
  await configureListenerFromSeeds(bindingId);
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
  const { postEnableNotice } = await import("./notice-service.js");
  await postEnableNotice(out.binding.id);
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
export async function setListenerFolders(bindingId: string, folders: string[], peopleFolders: string[] = [], seed: ListenerSeedSettings = {}): Promise<void> {
  const ok = (f: unknown): f is string => typeof f === "string" && (f === ROOT_FOLDER || FOLDER_RE.test(f));
  if (!folders.every(ok) || !peopleFolders.every((f) => ok(f) && folders.includes(f))) throw new Error("invalid listener folders");
  const tagsOk = (v: string[] | undefined) => v === undefined || v.every((t) => typeof t === "string" && SLUG.test(t));
  if (!tagsOk(seed.domainTags) || !tagsOk(seed.neverPropose)) throw new Error("invalid listener seed settings");
  if (seed.neverTerms && !seed.neverTerms.every((t) => typeof t === "string" && TERM.test(t))) throw new Error("invalid listener seed settings");
  if (seed.adminFolders && !seed.adminFolders.every((f) => typeof f === "string" && FOLDER_PATH_RE.test(f))) throw new Error("invalid listener seed settings");
  const row = await getBindingRow(bindingId);
  if (!row?.listener_agent_node_id) throw new Error("binding has no listener");
  const agent = await getAgent(row.nest_id, row.listener_agent_node_id);
  if (!isListenerOf(agent, bindingId)) throw new Error("binding has no listener");
  const cfg = agent.config as ListenerConfig;
  const next = {
    ...cfg,
    surfaces_listener: {
      ...cfg.surfaces_listener,
      folders: [...new Set(folders)],
      people_folders: [...new Set(peopleFolders)],
      ...(seed.domainTags ? { domain_tags: [...new Set(seed.domainTags)] } : {}),
      ...(seed.neverPropose ? { never_propose: [...new Set(seed.neverPropose)] } : {}),
      ...(seed.neverTerms ? { never_terms: [...new Set(seed.neverTerms)] } : {}),
      ...(seed.adminFolders ? { admin_folders: [...new Set(seed.adminFolders)] } : {}),
      ...(seed.thesisNodeId !== undefined ? { thesis_node_id: seed.thesisNodeId } : {}),
    },
  };
  await getDb().run("UPDATE metacognition_agents SET config_json = ?, updated_at = ? WHERE nest_id = ? AND node_id = ? AND enabled = 0", [
    JSON.stringify(next),
    new Date().toISOString(),
    row.nest_id,
    row.listener_agent_node_id,
  ]);
}
