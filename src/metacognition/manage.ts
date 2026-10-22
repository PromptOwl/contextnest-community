/**
 * The metacognition operations REST (routes.ts) and MCP (mcp/metacognition-tools.ts)
 * both call, so the two surfaces share one set of gates and can't drift.
 *
 * Metacognition is an owner/admin feature for every action — listing, viewing,
 * stats, running, configuring and removing: an agent spends a key's budget on
 * its own and acts in the nest as a persona, so who may aim it and who may set
 * it off are the same people. A named system key never reaches it, whatever
 * its standing (REST: SYSTEM_DENIED_RESOURCES in app.ts).
 */
import { DocumentNotFoundError } from "@promptowl/contextnest-engine";
import { config } from "../config.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { permissionLevel, resolveNestPermission, type NestPermission } from "../shared/access.js";
import { getDb } from "../db/client.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { engineCache } from "../nodes/engine.js";
import { isSystemUser } from "../auth/systems.js";
import { parseConfig, type MetacognitionConfig } from "./config.js";
import { listAgents, getAgent, upsertAgent, deleteAgent, type MetacognitionAgent } from "./store.js";
import { agentStats } from "./stats.js";

export const NOT_ENABLED =
  "Metacognition agents are not enabled on this server. An admin can turn them on with FEATURE_METACOGNITION=true (and FEATURE_WORKFLOW_PLANE=true).";
export const ADMIN_ONLY = "Only the nest owner or an admin can set up or run a metacognition agent.";
/** The words app.ts answers a system key with on every SYSTEM_DENIED_RESOURCES route. */
export const SYSTEM_DENIED =
  "A system key can't manage this nest's people, settings, publishing, keys or automation.";

export function metacognitionEnabled(): boolean {
  return config.FEATURE_WORKFLOW_PLANE && config.FEATURE_METACOGNITION;
}

export function assertMetacognitionEnabled(): void {
  if (!metacognitionEnabled()) throw new NotFoundError(NOT_ENABLED);
}

/** Owner or admin on the nest, or refuse. */
export function requireMetacognitionAdmin(perm: NestPermission | null | undefined): void {
  if (perm !== "owner" && perm !== "admin") throw new ForbiddenError(ADMIN_ONLY);
}

/**
 * The gate for a caller REST's nest middleware hasn't already resolved (MCP,
 * the generic run trigger, schedules, hooks): no system key, then owner/admin.
 * Open mode is the owner, as everywhere else.
 */
export async function assertCanManageMetacognition(
  nestId: string,
  userId: string,
  perm?: NestPermission | null,
): Promise<void> {
  if (await isSystemUser(userId)) throw new ForbiddenError(SYSTEM_DENIED);
  const resolved =
    perm !== undefined ? perm : config.AUTH_MODE === "open" ? "owner" : await resolveNestPermission(nestId, userId);
  requireMetacognitionAdmin(resolved);
}

/** Is this node a configured metacognition agent? (Any state: a switched-off
 *  one can be switched back on, so who may aim it still matters.) */
export async function isMetacognitionAgent(nestId: string, nodeId: string): Promise<boolean> {
  return !!(await getAgent(nestId, nodeId));
}

export function agentView(a: MetacognitionAgent) {
  return {
    node_id: a.node_id,
    enabled: a.enabled,
    persona: { name: a.persona.name, avatar: a.persona.avatar, email: a.persona.email },
    scope: a.config.scope,
    caps: a.config.caps,
    feeds: a.config.feeds,
    // auth_env is a NAME of an env value, never the value — safe to return.
    mcp_servers: a.config.mcp_servers,
    model: a.config.model,
    // The owner: who set it up (or took it over when they could no longer
    // run it). Saving the settings does not change it.
    configured_by: a.created_by,
    updated_at: a.updated_at,
  };
}

/** Same rule the run gate applies: a real (non-service) account that still
 *  holds write on the nest. */
export async function ownerCanRun(nestId: string, email: string): Promise<boolean> {
  const row = (await getDb().get(
    "SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND COALESCE(is_service, 0) = 0",
    [email],
  )) as { id: string } | undefined;
  if (!row) return false;
  return permissionLevel(await resolveNestPermission(nestId, row.id)) >= permissionLevel("write");
}

export async function listAgentViews(nestId: string) {
  return (await listAgents(nestId)).map(agentView);
}

export async function getAgentView(nestId: string, rawNodeId: string) {
  const nodeId = assertSafeNodeId(rawNodeId);
  const agent = await getAgent(nestId, nodeId);
  if (!agent) throw new NotFoundError(`${nodeId} is not a metacognition agent`);
  return agentView(agent);
}

/**
 * Validate a PUT body against the node: it must be an agent document, and the
 * body must pass parseConfig. Returns the normalized config, saving nothing —
 * what a dry run shows and a save stores.
 */
export async function validateAgentConfig(
  nestId: string,
  rawNodeId: string,
  body: Record<string, unknown>,
): Promise<{ nodeId: string; config: MetacognitionConfig; enabled: boolean }> {
  const nodeId = assertSafeNodeId(rawNodeId);
  const { storage } = await engineCache.get(nestId);
  let doc;
  try {
    doc = await storage.readDocument(nodeId);
  } catch (err) {
    if (err instanceof DocumentNotFoundError) throw new ValidationError(`No document ${nodeId}`);
    throw err;
  }
  if ((doc.frontmatter.type || "document") !== "agent") {
    throw new ValidationError(`${nodeId} is a "${doc.frontmatter.type || "document"}" — only an agent document can be a metacognition agent.`);
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw new ValidationError("enabled must be true or false");
  }
  return { nodeId, config: parseConfig(body), enabled: body.enabled !== false };
}

export async function configureAgent(opts: {
  nestId: string;
  nodeId: string;
  body: Record<string, unknown>;
  savedBy: string;
}) {
  const { nodeId, config: parsed, enabled } = await validateAgentConfig(opts.nestId, opts.nodeId, opts.body);
  const agent = await upsertAgent({
    nestId: opts.nestId,
    nodeId,
    config: parsed,
    enabled,
    savedBy: opts.savedBy,
    ownerUsable: (email) => ownerCanRun(opts.nestId, email),
  });
  return { ...agentView(agent), owner_changed: agent.ownerChanged };
}

/** Stop a node being a metacognition agent. The document stays. */
export async function removeAgent(nestId: string, rawNodeId: string): Promise<void> {
  const nodeId = assertSafeNodeId(rawNodeId);
  if (!(await deleteAgent(nestId, nodeId))) throw new NotFoundError(`${nodeId} is not a metacognition agent`);
}

/** Start a run: the same one-at-a-time 409 and hourly start limit wherever it is triggered. */
export async function runAgent(opts: { nestId: string; nodeId: string; triggeredBy: string; inputs?: unknown }) {
  // Loaded on use, as run-routes, hooks and the scheduler do: the run loop
  // pulls in the model client, which nothing that only gates needs.
  const { startMetacognitionRun } = await import("./service.js");
  const runId = await startMetacognitionRun({
    nestId: opts.nestId,
    nodeId: assertSafeNodeId(opts.nodeId),
    triggeredBy: opts.triggeredBy,
    inputs: opts.inputs,
  });
  return { run_id: runId, executes: "server" as const };
}

export async function agentStatsFor(nestId: string, rawNodeId: string, opts: { days?: number; limit?: number }) {
  const nodeId = assertSafeNodeId(rawNodeId);
  if (!(await getAgent(nestId, nodeId))) throw new NotFoundError(`${nodeId} is not a metacognition agent`);
  return agentStats(nestId, nodeId, opts);
}
