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
import { permissionLevel } from "../shared/access.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { engineCache } from "../nodes/engine.js";
import { parseConfig } from "./config.js";
import { listAgents, getAgent, upsertAgent, deleteAgent, type MetacognitionAgent } from "./store.js";
import { startMetacognitionRun } from "./service.js";

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
    configured_by: a.created_by,
    updated_at: a.updated_at,
  };
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
    createdBy: await resolveCallerEmail(c.get("userId")),
  });
  return c.json({ agent: toResponse(agent) });
});

metacognitionRoutes.delete("/:nodeId{.+}", requireMetacognition, async (c) => {
  requireTier(c, "admin");
  const nodeId = assertSafeNodeId(c.req.param("nodeId")!);
  const removed = await deleteAgent(c.req.param("nestId")!, nodeId);
  if (!removed) throw new NotFoundError(`${nodeId} is not a metacognition agent`);
  return c.json({ deleted: true });
});
