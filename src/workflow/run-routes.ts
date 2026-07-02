/**
 * Runs — the operational trace of the workflow plane ("turing" track).
 *
 * The server never executes anything: an external runner (Hootie, Claude,
 * Temporal worker) calls POST /run/<agent> and receives the full executable
 * BUNDLE in one round-trip — agent instructions, the flow-edge subgraph
 * reachable from it, and every definition its structured conditions
 * reference. The runner walks the edges, appends a step per action, and
 * closes the run. Because retrieval is deterministic (selector+hops), a
 * recorded run replays to the identical read-set.
 *
 * Feature-flagged like the rest of the plane.
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import type { AuthEnv } from "../auth/middleware.js";
import { getDb } from "../db/client.js";
import { engineCache } from "../nodes/engine.js";
import { config } from "../config.js";
import { ValidationError, NotFoundError, ConflictError, ForbiddenError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { resolveNestPermission, permissionLevel } from "../shared/access.js";
import { requireWorkflowPlane } from "./edge-type-routes.js";

const RUNNABLE_TYPES = ["agent", "skill"];

interface RunRow {
  id: string;
  nest_id: string;
  agent_node: string;
  triggered_by: string;
  status: string;
  inputs: string | null;
  trace: string | null;
  started_at: string;
  finished_at: string | null;
}

const safeJson = (s: string | null): unknown => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** Flow-edge subgraph reachable from the agent node (BFS, directed). */
async function flowSubgraph(nestId: string, agentNode: string) {
  const db = getDb();
  const rows = (await db.all(
    `SELECT e.id, e.from_node, e.to_node, e.condition_mode, e.condition, e.metadata,
            t.name as type_name, t.color as type_color
       FROM edges e JOIN edge_types t ON t.id = e.type_id
      WHERE e.nest_id = ? AND t.is_flow = 1`,
    [nestId],
  )) as Array<{
    id: string; from_node: string; to_node: string;
    condition_mode: string | null; condition: string | null; metadata: string | null;
    type_name: string; type_color: string | null;
  }>;
  const byFrom = new Map<string, typeof rows>();
  for (const r of rows) {
    (byFrom.get(r.from_node) ?? byFrom.set(r.from_node, []).get(r.from_node)!).push(r);
  }
  const seen = new Set([agentNode]);
  const queue = [agentNode];
  const edges: typeof rows = [];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of byFrom.get(cur) ?? []) {
      edges.push(e);
      if (!seen.has(e.to_node)) {
        seen.add(e.to_node);
        queue.push(e.to_node);
      }
    }
  }
  return edges.map((e) => ({
    id: e.id,
    from_node: e.from_node,
    to_node: e.to_node,
    type: { name: e.type_name, color: e.type_color },
    condition_mode: e.condition_mode,
    condition:
      e.condition_mode === "structured" ? safeJson(e.condition) : e.condition,
    metadata: safeJson(e.metadata),
  }));
}

/** Definitions referenced by structured conditions in the bundle. */
async function referencedDefinitions(
  nestId: string,
  edges: Array<{ condition_mode: string | null; condition: unknown }>,
) {
  const terms = new Set<string>();
  for (const e of edges) {
    if (e.condition_mode === "structured" && e.condition && typeof e.condition === "object") {
      const t = (e.condition as any).term;
      if (typeof t === "string" && t.trim()) terms.add(t.trim());
    }
  }
  if (!terms.size) return [];
  const out: unknown[] = [];
  try {
    const db = getDb();
    for (const term of terms) {
      const row = await db.get(
        "SELECT term, definition, linked_tag FROM definitions WHERE nest_id = ? AND LOWER(term) = LOWER(?)",
        [nestId, term],
      );
      if (row) out.push(row);
    }
  } catch {
    /* definitions table not on this deployment yet — bundle ships without */
  }
  return out;
}

// ─── Nest-scoped routes: trigger + list ─────────────────────────────────

export const runTriggerRoutes = new Hono<AuthEnv>();
runTriggerRoutes.use("*", requireWorkflowPlane);

// POST /nests/:nestId/run/:agentNode{.+}
runTriggerRoutes.post("/:agentNode{.+}", async (c) => {
  const nestId = c.req.param("nestId")!;
  const agentNode = c.req.param("agentNode")!;
  const body = await c.req
    .json<{ inputs?: unknown; triggered_by?: string }>()
    .catch(() => ({}) as { inputs?: unknown; triggered_by?: string });

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
      `"${agentNode}" is type "${nodeType}" — only agent/skill nodes are runnable`,
    );
  }

  const edges = await flowSubgraph(nestId, agentNode);
  const definitions = await referencedDefinitions(nestId, edges);
  const triggeredBy =
    typeof body.triggered_by === "string" && body.triggered_by.trim()
      ? body.triggered_by.trim()
      : await resolveCallerEmail(c.get("userId"));

  const id = `run_${uuid()}`;
  await getDb().run(
    `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, inputs, started_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    [
      id,
      nestId,
      agentNode,
      triggeredBy,
      body.inputs === undefined ? null : JSON.stringify(body.inputs),
      new Date().toISOString(),
    ],
  );

  return c.json(
    {
      run_id: id,
      agent: {
        id: agentNode,
        title: String(doc.frontmatter.title ?? agentNode),
        type: nodeType,
        schedule: (doc.frontmatter.metadata as any)?.schedule ?? null,
        content: doc.body || "",
      },
      edges,
      definitions,
      trace_hint: {
        retrieval:
          "POST /context is deterministic — record selector+hops per read so the run replays to the identical read-set",
        steps: "POST /runs/{run_id}/steps per action; PATCH /runs/{run_id} to close",
      },
    },
    201,
  );
});

// GET /nests/:nestId/runs?agent=&status=&limit=
export const runListRoutes = new Hono<AuthEnv>();
runListRoutes.use("*", requireWorkflowPlane);
runListRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const db = getDb();
  let sql = "SELECT * FROM runs WHERE nest_id = ?";
  const args: unknown[] = [nestId];
  const agent = c.req.query("agent");
  const status = c.req.query("status");
  if (agent) {
    sql += " AND agent_node = ?";
    args.push(agent);
  }
  if (status) {
    sql += " AND status = ?";
    args.push(status);
  }
  sql += " ORDER BY started_at DESC LIMIT ?";
  args.push(Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500));
  const rows = (await db.all(sql, args as any)) as RunRow[];
  return c.json({
    count: rows.length,
    runs: rows.map((r) => ({ ...r, inputs: safeJson(r.inputs), trace: safeJson(r.trace) })),
  });
});

// ─── Top-level /runs/:id routes (runner-facing) ─────────────────────────
// Auth: resolve the run's nest, then enforce nest permission — write for
// stepping/closing, read for viewing (with NL rationale redacted at read
// tier, same posture as changes-since deleted[]).

export const runDetailRoutes = new Hono<AuthEnv>();
runDetailRoutes.use("*", requireWorkflowPlane);

async function loadRunWithPermission(
  c: any,
  runId: string,
  required: "read" | "write",
): Promise<RunRow> {
  const run = (await getDb().get("SELECT * FROM runs WHERE id = ?", [
    runId,
  ])) as RunRow | undefined;
  if (!run) throw new NotFoundError("Run not found");
  const perm =
    config.AUTH_MODE === "open"
      ? "owner"
      : await resolveNestPermission(run.nest_id, c.get("userId"));
  if (permissionLevel(perm) < permissionLevel(required)) {
    throw new ForbiddenError(
      `This run belongs to a nest where you lack ${required} access.`,
    );
  }
  (c as any).set("runPermission", perm);
  return run;
}

// POST /runs/:id/steps
runDetailRoutes.post("/:id/steps", async (c) => {
  const run = await loadRunWithPermission(c, c.req.param("id")!, "write");
  if (run.status !== "running") {
    throw new ConflictError(`Run is ${run.status} — steps can't be appended`);
  }
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.action !== "string" || !body.action.trim()) {
    throw new ValidationError("action is required (read|write|branch|notify|external)");
  }
  const db = getDb();
  const last = (await db.get(
    "SELECT MAX(seq) as m FROM run_steps WHERE run_id = ?",
    [run.id],
  )) as { m: number | null };
  const seq =
    typeof body.seq === "number" && Number.isInteger(body.seq)
      ? body.seq
      : (last.m ?? 0) + 1;
  await db.run(
    `INSERT INTO run_steps (run_id, seq, node_id, edge_id, action, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      seq,
      typeof body.node_id === "string" ? body.node_id : null,
      typeof body.edge_id === "string" ? body.edge_id : null,
      body.action.trim(),
      body.detail === undefined ? null : JSON.stringify(body.detail),
      new Date().toISOString(),
    ],
  );
  return c.json({ ok: true, seq }, 201);
});

// PATCH /runs/:id — close or update status/trace
runDetailRoutes.patch("/:id", async (c) => {
  const run = await loadRunWithPermission(c, c.req.param("id")!, "write");
  if (run.status !== "running") {
    throw new ConflictError(`Run already terminal (${run.status})`);
  }
  const body = await c.req.json<Record<string, unknown>>();
  const status = body.status;
  if (
    typeof status !== "string" ||
    !["running", "succeeded", "failed", "cancelled"].includes(status)
  ) {
    throw new ValidationError("status must be running | succeeded | failed | cancelled");
  }
  const terminal = status !== "running";
  await getDb().run(
    `UPDATE runs SET status = ?, trace = COALESCE(?, trace), finished_at = ? WHERE id = ?`,
    [
      status,
      body.trace === undefined ? null : JSON.stringify(body.trace),
      terminal ? new Date().toISOString() : null,
      run.id,
    ],
  );
  return c.json({ ok: true, status });
});

// GET /runs/:id — full trace; NL rationales redacted below write tier.
runDetailRoutes.get("/:id", async (c) => {
  const run = await loadRunWithPermission(c, c.req.param("id")!, "read");
  const canSeeDetail =
    permissionLevel((c as any).get("runPermission")) >=
    permissionLevel("write");
  const steps = (await getDb().all(
    "SELECT seq, node_id, edge_id, action, detail, at FROM run_steps WHERE run_id = ? ORDER BY seq",
    [run.id],
  )) as Array<{ seq: number; node_id: string | null; edge_id: string | null; action: string; detail: string | null; at: string }>;
  return c.json({
    run: { ...run, inputs: safeJson(run.inputs), trace: safeJson(run.trace) },
    steps: steps.map((s) => ({
      ...s,
      detail: canSeeDetail ? safeJson(s.detail) : null,
    })),
  });
});
