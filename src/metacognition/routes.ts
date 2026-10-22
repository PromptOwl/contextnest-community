/**
 * /nests/:nestId/metacognition — configure and run metacognition agents.
 *
 * Gated twice: the workflow plane (runs, schedules, the trace) and
 * FEATURE_METACOGNITION; either off → 404. Every action here — listing,
 * viewing, stats, running, configuring, removing — takes the nest owner or an
 * admin (see manage.ts). The handlers are thin: the operations live in
 * manage.ts, which the MCP tools call too.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { ValidationError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import {
  NOT_ENABLED,
  metacognitionEnabled,
  requireMetacognitionAdmin,
  listAgentViews,
  getAgentView,
  configureAgent,
  removeAgent,
  runAgent,
  agentStatsFor,
} from "./manage.js";

export { ownerCanRun } from "./manage.js";

export const requireMetacognition = async (c: any, next: any) => {
  if (!metacognitionEnabled()) return c.json({ error: NOT_ENABLED }, 404);
  return next();
};

export const metacognitionRoutes = new Hono<AuthEnv>();

metacognitionRoutes.get("/", requireMetacognition, async (c) => {
  requireMetacognitionAdmin(c.get("nestPermission"));
  return c.json({ agents: await listAgentViews(c.req.param("nestId")!) });
});

metacognitionRoutes.post("/:nodeId{.+}/run", requireMetacognition, async (c) => {
  requireMetacognitionAdmin(c.get("nestPermission"));
  const body = await c.req.json<{ inputs?: unknown }>().catch(() => ({}) as { inputs?: unknown });
  const started = await runAgent({
    nestId: c.req.param("nestId")!,
    nodeId: c.req.param("nodeId")!,
    triggeredBy: await resolveCallerEmail(c.get("userId")),
    inputs: body.inputs,
  });
  return c.json(started, 202);
});

// What the agent did over a window: run outcomes, tokens and cost, how its
// proposals were judged, and its recent runs. Same access as viewing the agent.
// Registered before GET /:nodeId so the catch-all doesn't swallow "/stats".
metacognitionRoutes.get("/:nodeId{.+}/stats", requireMetacognition, async (c) => {
  requireMetacognitionAdmin(c.get("nestPermission"));
  const num = (k: string) => {
    const raw = c.req.query(k);
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new ValidationError(`${k} must be a positive whole number`);
    return n;
  };
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  // Existence before the query params, as before: a bad agent is a 404 first.
  await getAgentView(nestId, nodeId);
  return c.json({ stats: await agentStatsFor(nestId, nodeId, { days: num("days"), limit: num("limit") }) });
});

metacognitionRoutes.get("/:nodeId{.+}", requireMetacognition, async (c) => {
  requireMetacognitionAdmin(c.get("nestPermission"));
  return c.json({ agent: await getAgentView(c.req.param("nestId")!, c.req.param("nodeId")!) });
});

metacognitionRoutes.put("/:nodeId{.+}", requireMetacognition, async (c) => {
  requireMetacognitionAdmin(c.get("nestPermission"));
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const agent = await configureAgent({
    nestId: c.req.param("nestId")!,
    nodeId: c.req.param("nodeId")!,
    body,
    savedBy: await resolveCallerEmail(c.get("userId")),
  });
  return c.json({ agent });
});

metacognitionRoutes.delete("/:nodeId{.+}", requireMetacognition, async (c) => {
  requireMetacognitionAdmin(c.get("nestPermission"));
  await removeAgent(c.req.param("nestId")!, c.req.param("nodeId")!);
  return c.json({ deleted: true });
});
