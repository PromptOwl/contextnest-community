/**
 * /nests/:nestId/metacognition — configure and run metacognition agents.
 *
 * Gated twice: the workflow plane (runs, schedules, the trace) and
 * FEATURE_METACOGNITION; either off → 404. Configuring an agent hands an
 * autonomous loop a scope and a key's spend, so it takes an owner or admin;
 * listing and running take write.
 */
import { Hono } from "hono";
import { DocumentNotFoundError } from "@promptowl/contextnest-engine";
import type { AuthEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { permissionLevel, resolveNestPermission } from "../shared/access.js";
import { getDb } from "../db/client.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { engineCache } from "../nodes/engine.js";
import { parseConfig } from "./config.js";
import { suggestConfig } from "./suggest.js";
import { listNestFolders } from "../nodes/service.js";
import { resolveExportBody } from "../nodes/readable-body.js";
import { listAgents, getAgent, upsertAgent, deleteAgent, type MetacognitionAgent } from "./store.js";
import { startMetacognitionRun } from "./service.js";
import { agentStats } from "./stats.js";

export const requireMetacognition = async (c: any, next: any) => {
  if (!config.FEATURE_WORKFLOW_PLANE || !config.FEATURE_METACOGNITION) {
    return c.json(
      {
        error:
          "Metacognition agents are not enabled on this server. An admin can turn them on with FEATURE_METACOGNITION=true (and FEATURE_WORKFLOW_PLANE=true).",
      },
      404,
    );
  }
  return next();
};

function requireTier(c: any, tier: "write" | "admin"): void {
  const p = c.get("nestPermission");
  const ok = tier === "admin" ? p === "owner" || p === "admin" : permissionLevel(p) >= permissionLevel("write");
  if (!ok) {
    throw new ForbiddenError(
      tier === "admin"
        ? "Only the nest owner or an admin can configure a metacognition agent."
        : "Write access is required.",
    );
  }
}

function toResponse(a: MetacognitionAgent) {
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

export const metacognitionRoutes = new Hono<AuthEnv>();

metacognitionRoutes.get("/", requireMetacognition, async (c) => {
  requireTier(c, "write");
  const agents = await listAgents(c.req.param("nestId")!);
  return c.json({ agents: agents.map(toResponse) });
});

metacognitionRoutes.post("/:nodeId{.+}/run", requireMetacognition, async (c) => {
  requireTier(c, "write");
  const nestId = c.req.param("nestId")!;
  const nodeId = assertSafeNodeId(c.req.param("nodeId")!);
  const body = await c.req.json<{ inputs?: unknown }>().catch(() => ({}) as { inputs?: unknown });
  const runId = await startMetacognitionRun({
    nestId,
    nodeId,
    triggeredBy: await resolveCallerEmail(c.get("userId")),
    inputs: body.inputs,
  });
  return c.json({ run_id: runId, executes: "server" }, 202);
});

// What the agent did over a window: run outcomes, tokens and cost, how its
// proposals were judged, and its recent runs. Same access as viewing the agent.
// Registered before GET /:nodeId so the catch-all doesn't swallow "/stats".
metacognitionRoutes.get("/:nodeId{.+}/stats", requireMetacognition, async (c) => {
  requireTier(c, "write");
  const nestId = c.req.param("nestId")!;
  const nodeId = assertSafeNodeId(c.req.param("nodeId")!);
  if (!(await getAgent(nestId, nodeId))) throw new NotFoundError(`${nodeId} is not a metacognition agent`);
  const num = (k: string) => {
    const raw = c.req.query(k);
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new ValidationError(`${k} must be a positive whole number`);
    return n;
  };
  return c.json({ stats: await agentStats(nestId, nodeId, { days: num("days"), limit: num("limit") }) });
});

/** The agent document behind a config; 400 when there is none, or it isn't an agent. */
async function readAgentDoc(nestId: string, nodeId: string) {
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
  return doc;
}

// A starting config read off the agent document, for the setup form to
// prefill (CU-wdqcq05rkp). Same gates as PUT, since what it returns is what a
// PUT would grant; it saves nothing. It reads the approved instructions — the
// text a run reads — so an unreviewed draft can't widen the suggested scope.
// Registered before GET /:nodeId so the catch-all doesn't swallow "/suggest"
// (as with "/stats", a document id ending in /suggest can't be read through
// GET /:nodeId — agent ids don't, in practice).
metacognitionRoutes.get("/:nodeId{.+}/suggest", requireMetacognition, async (c) => {
  requireTier(c, "admin");
  const nestId = c.req.param("nestId")!;
  const nodeId = assertSafeNodeId(c.req.param("nodeId")!);
  const doc = await readAgentDoc(nestId, nodeId);
  const instructions = await resolveExportBody(nestId, nodeId, doc.body || "");
  const folders = (await listNestFolders(nestId)).map((f) => f.path);
  const suggestion = suggestConfig({
    title: String(doc.frontmatter.title || nodeId.replace(/^nodes\//, "")),
    frontmatter: { ...doc.frontmatter } as Record<string, unknown>,
    instructions,
    folders,
  });
  return c.json({ suggestion: { ...suggestion, instructions: instructions === null ? "none" : "approved" } });
});

metacognitionRoutes.get("/:nodeId{.+}", requireMetacognition, async (c) => {
  requireTier(c, "write");
  const nodeId = assertSafeNodeId(c.req.param("nodeId")!);
  const agent = await getAgent(c.req.param("nestId")!, nodeId);
  if (!agent) throw new NotFoundError(`${nodeId} is not a metacognition agent`);
  return c.json({ agent: toResponse(agent) });
});

metacognitionRoutes.put("/:nodeId{.+}", requireMetacognition, async (c) => {
  requireTier(c, "admin");
  const nestId = c.req.param("nestId")!;
  const nodeId = assertSafeNodeId(c.req.param("nodeId")!);
  await readAgentDoc(nestId, nodeId);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw new ValidationError("enabled must be true or false");
  }
  const parsed = parseConfig(body);
  const agent = await upsertAgent({
    nestId,
    nodeId,
    config: parsed,
    enabled: body.enabled !== false,
    savedBy: await resolveCallerEmail(c.get("userId")),
    ownerUsable: (email) => ownerCanRun(nestId, email),
  });
  return c.json({ agent: { ...toResponse(agent), owner_changed: agent.ownerChanged } });
});

metacognitionRoutes.delete("/:nodeId{.+}", requireMetacognition, async (c) => {
  requireTier(c, "admin");
  const nodeId = assertSafeNodeId(c.req.param("nodeId")!);
  const removed = await deleteAgent(c.req.param("nestId")!, nodeId);
  if (!removed) throw new NotFoundError(`${nodeId} is not a metacognition agent`);
  return c.json({ deleted: true });
});
