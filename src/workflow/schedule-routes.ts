/**
 * Schedule CRUD — /nests/:nestId/schedules. One schedule per agent per nest
 * (the unique index enforces it): "create a run for this agent every N
 * minutes". The loop in scheduler.ts does the firing; these routes only
 * manage the rows. Feature-gated like the rest of the workflow plane.
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import type { AuthEnv } from "../auth/middleware.js";
import { getDb } from "../db/client.js";
import { engineCache } from "../nodes/engine.js";
import { ValidationError, NotFoundError, ConflictError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { requireWorkflowPlane } from "./edge-type-routes.js";
import { isMetacognitionAgent, requireMetacognitionAdmin } from "../metacognition/manage.js";

const RUNNABLE_TYPES = ["agent", "skill"];
// 5 minutes to 7 days — below 5m a polling runner can't keep up anyway.
const MIN_EVERY = 5;
const MAX_EVERY = 7 * 24 * 60;

interface ScheduleRow {
  id: string;
  nest_id: string;
  agent_node: string;
  every_minutes: number;
  enabled: number;
  last_run_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  max_runs: number | null;
  runs_created: number;
}

function toResponse(s: ScheduleRow) {
  const last = s.last_run_at ? Date.parse(s.last_run_at) : NaN;
  return {
    id: s.id,
    agent_node: s.agent_node,
    every_minutes: s.every_minutes,
    enabled: !!s.enabled,
    last_run_at: s.last_run_at,
    // Derived, not stored: when the loop will next fire this schedule.
    next_due_at: s.enabled
      ? Number.isNaN(last)
        ? new Date().toISOString()
        : new Date(last + s.every_minutes * 60_000).toISOString()
      : null,
    max_runs: s.max_runs,
    runs_created: s.runs_created,
    created_by: s.created_by,
    created_at: s.created_at,
  };
}

/** null/undefined = run forever; otherwise a positive run count. */
function parseMaxRuns(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) {
    throw new ValidationError("max_runs must be a positive integer (or null for no bound)");
  }
  return n;
}

function parseEvery(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < MIN_EVERY || n > MAX_EVERY) {
    throw new ValidationError(
      `every_minutes must be an integer between ${MIN_EVERY} and ${MAX_EVERY}`,
    );
  }
  return n;
}

export const scheduleRoutes = new Hono<AuthEnv>();
// Per-route gating (not use("*")) — see the LinearRouter note in edge-routes.

// GET /nests/:nestId/schedules
scheduleRoutes.get("/", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  const rows = (await getDb().all(
    "SELECT * FROM schedules WHERE nest_id = ? ORDER BY created_at",
    [nestId],
  )) as ScheduleRow[];
  return c.json({ count: rows.length, schedules: rows.map(toResponse) });
});

// POST /nests/:nestId/schedules { agent_node, every_minutes, enabled? }
scheduleRoutes.post("/", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<Record<string, unknown>>();
  const agentRaw = typeof body.agent_node === "string" ? body.agent_node.trim() : "";
  if (!agentRaw) throw new ValidationError("agent_node is required");
  const agentNode = assertSafeNodeId(agentRaw);
  const every = parseEvery(body.every_minutes);
  const maxRuns = parseMaxRuns(body.max_runs);

  // Same runnability contract as the manual trigger.
  const { storage } = await engineCache.get(nestId);
  let doc;
  try {
    doc = await storage.readDocument(agentNode);
  } catch {
    throw new NotFoundError(`Agent node not found: ${agentNode}`);
  }
  const nodeType = doc.frontmatter.type || "document";
  if (!RUNNABLE_TYPES.includes(nodeType)) {
    throw new ValidationError(
      `"${agentNode}" is type "${nodeType}" — only agent/skill nodes are schedulable`,
    );
  }

  // A metacognition agent run on a schedule spends a key on its own: setting
  // that up is owner/admin, like everything else about the agent.
  if (await isMetacognitionAgent(nestId, agentNode)) requireMetacognitionAdmin(c.get("nestPermission"));

  const db = getDb();
  const existing = await db.get(
    "SELECT id FROM schedules WHERE nest_id = ? AND agent_node = ?",
    [nestId, agentNode],
  );
  if (existing) {
    throw new ConflictError(
      "This agent already has a schedule — edit or delete it instead",
    );
  }

  const now = new Date().toISOString();
  const id = `sch_${uuid()}`;
  await db.run(
    `INSERT INTO schedules (id, nest_id, agent_node, every_minutes, enabled, last_run_at, max_runs, runs_created, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?)`,
    [
      id,
      nestId,
      agentNode,
      every,
      body.enabled === false ? 0 : 1,
      maxRuns,
      await resolveCallerEmail(c.get("userId")),
      now,
      now,
    ],
  );
  const row = (await db.get("SELECT * FROM schedules WHERE id = ?", [id])) as ScheduleRow;
  return c.json({ schedule: toResponse(row) }, 201);
});

// PATCH /nests/:nestId/schedules/:id { every_minutes?, enabled? }
scheduleRoutes.patch("/:id", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  const id = c.req.param("id")!;
  const body = await c.req.json<Record<string, unknown>>();

  const db = getDb();
  const row = (await db.get(
    "SELECT * FROM schedules WHERE id = ? AND nest_id = ?",
    [id, nestId],
  )) as ScheduleRow | undefined;
  if (!row) throw new NotFoundError("Schedule not found");
  // Retuning or switching on a metacognition agent's schedule: owner/admin.
  // (Deleting one, which only stops spend, stays at write.)
  if (await isMetacognitionAgent(nestId, row.agent_node)) requireMetacognitionAdmin(c.get("nestPermission"));

  const every =
    body.every_minutes === undefined ? row.every_minutes : parseEvery(body.every_minutes);
  const enabled =
    body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0;
  const maxRuns =
    body.max_runs === undefined ? row.max_runs : parseMaxRuns(body.max_runs);
  // Re-enabling or raising the bound restarts the count — "10 more from now".
  const runsCreated =
    body.max_runs !== undefined || (body.enabled && !row.enabled)
      ? 0
      : row.runs_created;

  await db.run(
    `UPDATE schedules SET every_minutes = ?, enabled = ?, max_runs = ?, runs_created = ?, updated_at = ?
      WHERE id = ?`,
    [every, enabled, maxRuns, runsCreated, new Date().toISOString(), id],
  );
  const updated = (await db.get("SELECT * FROM schedules WHERE id = ?", [id])) as ScheduleRow;
  return c.json({ schedule: toResponse(updated) });
});

// DELETE /nests/:nestId/schedules/:id
scheduleRoutes.delete("/:id", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  const id = c.req.param("id")!;
  const db = getDb();
  const row = await db.get(
    "SELECT id FROM schedules WHERE id = ? AND nest_id = ?",
    [id, nestId],
  );
  if (!row) throw new NotFoundError("Schedule not found");
  await db.run("DELETE FROM schedules WHERE id = ?", [id]);
  return c.json({ deleted: true });
});
