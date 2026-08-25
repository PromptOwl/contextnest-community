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
import { isSuspended, getSuspensionReason, getCurrentLicense } from "../auth/license.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { requireWorkflowPlane } from "./edge-type-routes.js";
import { cancelDescendants } from "./run-service.js";
import { envValues } from "./env-routes.js";
import { dispatchEvent } from "../notify/dispatch.js";

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
  parent_run_id: string | null;
  depth: number;
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
    if (!byFrom.has(r.from_node)) byFrom.set(r.from_node, []);
    byFrom.get(r.from_node)!.push(r);
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

/**
 * Everything a runner needs to walk an agent, minus run identity: agent doc,
 * flow subgraph, per-node types, reachable TOOL bodies, env store values,
 * and referenced definitions. Shared by POST /run/:agent (which creates the
 * run) and GET /runs/:id/bundle (which re-hands the bundle for a run created
 * server-side, e.g. by the interval scheduler).
 */
async function buildRunBundle(nestId: string, agentNode: string) {
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

  // Node types for every reachable node, so the runner knows which are
  // runnable (agent/skill → execute) vs write destinations (document →
  // receive the producing agent's output). Small graph; cheap reads.
  const reachable = new Set<string>([agentNode]);
  for (const e of edges) {
    reachable.add(e.from_node);
    reachable.add(e.to_node);
  }
  const node_types: Record<string, string> = {};
  // Tool nodes reachable from this agent travel WITH the bundle (body =
  // code the runner can execute as a tool). Documents don't — the runner
  // reads those through the governed /context path.
  const tools: Record<string, string> = {};
  for (const nid of reachable) {
    try {
      const d = await storage.readDocument(nid);
      const t = (d.frontmatter.type as string) || "document";
      node_types[nid] = t;
      if (t === "tool") tools[nid] = d.body || "";
    } catch {
      /* target not yet created — runner treats unknown as a write target */
    }
  }
  // Env store values ride along for the tools AND the runner's own LLM key
  // (ANTHROPIC_API_KEY set from the UI). The bundle requires write
  // permission to obtain, and this is the ONLY surface that returns full
  // values (the /env routes mask them).
  const env = await envValues(nestId);

  return {
    agent: {
      id: agentNode,
      title: String(doc.frontmatter.title ?? agentNode),
      type: nodeType,
      schedule: (doc.frontmatter.metadata as any)?.schedule ?? null,
      content: doc.body || "",
    },
    edges,
    node_types,
    tools,
    env,
    definitions,
  };
}

// ─── Nest-scoped routes: trigger + list ─────────────────────────────────

export const runTriggerRoutes = new Hono<AuthEnv>();
// Per-route (not use("*")): a wildcard middleware path under /run conflicts
// with the sibling /runs route in RegExpRouter and knocks the app onto
// TrieRouter, which cannot match deep-nested greedy suffix routes.

/**
 * Sub-agent recursion guard (FEATURE_SUBAGENT_RUNS). Given a claimed parent
 * run, validate it and return {depth, ancestors}. Enforces:
 *   - parent exists, same nest, still running (can't graft onto a closed run)
 *   - depth ≤ SUBAGENT_MAX_DEPTH (finite tree = haltable)
 *   - re-entrancy: the child agent isn't already anywhere in the ancestor
 *     chain (agent A→B→A would loop forever; the per-nest flow DAG guard
 *     can't see across run boundaries, so this is the cross-run cycle check)
 * The whole thing is gated: with the flag off, ANY parent_run_id is rejected.
 */
async function resolveParentRun(
  nestId: string,
  parentRunId: string,
  childAgent: string,
): Promise<{ depth: number }> {
  if (!config.FEATURE_SUBAGENT_RUNS) {
    throw new ValidationError(
      "Sub-agent runs are not enabled on this server (FEATURE_SUBAGENT_RUNS).",
    );
  }
  const db = getDb();
  const seen = new Set<string>();
  let cursor: string | null = parentRunId;
  let parentDepth = -1;
  // Walk the ancestor chain to the root, collecting agent_nodes. The depth
  // cap also bounds this walk, so a corrupted chain can't loop unbounded.
  for (let i = 0; i <= config.SUBAGENT_MAX_DEPTH + 1; i++) {
    if (!cursor) break;
    const row = (await db.get(
      "SELECT id, nest_id, agent_node, status, depth, parent_run_id FROM runs WHERE id = ?",
      [cursor],
    )) as
      | { id: string; nest_id: string; agent_node: string; status: string; depth: number; parent_run_id: string | null }
      | undefined;
    if (!row) throw new NotFoundError(`Parent run not found: ${cursor}`);
    if (row.nest_id !== nestId) {
      // Never let a parent in another nest pull a child into this one. 404,
      // not 403: don't confirm a cross-nest run's existence (no oracle).
      throw new NotFoundError(`Parent run not found: ${cursor}`);
    }
    if (cursor === parentRunId && row.status !== "running") {
      throw new ConflictError(
        `Parent run is ${row.status} — cannot spawn a sub-agent under a closed run`,
      );
    }
    if (row.agent_node === childAgent || seen.has(childAgent)) {
      throw new ConflictError(
        `re-entrancy: "${childAgent}" is already running in this call chain — sub-agent recursion must be acyclic`,
      );
    }
    seen.add(row.agent_node);
    if (cursor === parentRunId) parentDepth = row.depth;
    cursor = row.parent_run_id;
  }
  const depth = parentDepth + 1;
  if (depth > config.SUBAGENT_MAX_DEPTH) {
    throw new ForbiddenError(
      `sub-agent depth ${depth} exceeds the limit of ${config.SUBAGENT_MAX_DEPTH}`,
    );
  }
  // Depth bounds tree HEIGHT; this bounds WIDTH. Without it, a parent could
  // spawn unbounded siblings (each passes the per-chain checks) — a fork bomb
  // of DB rows and per-spawn work. Together they cap total tree size.
  const kids = (await db.get(
    "SELECT COUNT(*) as c FROM runs WHERE parent_run_id = ?",
    [parentRunId],
  )) as { c: number };
  if (kids.c >= config.SUBAGENT_MAX_CHILDREN) {
    throw new ForbiddenError(
      `parent run already has ${kids.c} children (limit ${config.SUBAGENT_MAX_CHILDREN})`,
    );
  }
  return { depth };
}

// POST /nests/:nestId/run/:agentNode{.+}
runTriggerRoutes.post("/:agentNode{.+}", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  // SECURITY: the catch-all param can carry `../` — validate before it reaches
  // storage.readDocument, or a caller with write on nest A reads nest B's
  // agent bodies via `..%2FB%2Fnodes%2Fsecret`. (See src/shared/node-id.ts.)
  const agentNode = assertSafeNodeId(c.req.param("agentNode")!);
  const body = await c.req
    .json<{ inputs?: unknown; parent_run_id?: unknown }>()
    .catch(() => ({}) as { inputs?: unknown; parent_run_id?: unknown });

  // Sub-agent (nested) run? Validate the parent chain before creating anything.
  let parentRunId: string | null = null;
  let depth = 0;
  if (body.parent_run_id !== undefined && body.parent_run_id !== null) {
    if (typeof body.parent_run_id !== "string") {
      throw new ValidationError("parent_run_id must be a string");
    }
    ({ depth } = await resolveParentRun(nestId, body.parent_run_id, agentNode));
    parentRunId = body.parent_run_id;
  }

  // Root-run flood cap: a single tree is bounded by the depth/fan-out caps,
  // but nothing limited how many depth-0 trees a write-tier caller could start.
  // Cap concurrently-running roots per nest. (Sub-agent runs are exempt — the
  // parent-chain caps already bound them.)
  if (parentRunId === null) {
    const { n } = (await getDb().get(
      `SELECT COUNT(*) AS n FROM runs
        WHERE nest_id = ? AND parent_run_id IS NULL AND status = 'running'`,
      [nestId],
    )) as { n: number };
    if (n >= config.RUN_MAX_CONCURRENT_ROOTS) {
      throw new ConflictError(
        `too many concurrent runs: ${n} already running (cap ${config.RUN_MAX_CONCURRENT_ROOTS}). Let some finish, or raise RUN_MAX_CONCURRENT_ROOTS.`,
      );
    }
  }

  const bundle = await buildRunBundle(nestId, agentNode);
  // Derived from auth, never client-supplied — this is the accountability
  // field ("who triggered this run"), so it must be trustworthy. A scheduler
  // or external runner authenticates with its own key; that identity is the
  // honest answer.
  const triggeredBy = await resolveCallerEmail(c.get("userId"));

  const id = `run_${uuid()}`;
  await getDb().run(
    `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, inputs, started_at, parent_run_id, depth)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    [
      id,
      nestId,
      agentNode,
      triggeredBy,
      body.inputs === undefined ? null : JSON.stringify(body.inputs),
      new Date().toISOString(),
      parentRunId,
      depth,
    ],
  );

  return c.json(
    {
      run_id: id,
      parent_run_id: parentRunId,
      depth,
      ...bundle,
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
runListRoutes.get("/", requireWorkflowPlane, async (c) => {
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
  // ?unclaimed=true → running runs no runner has claimed. The poll loop's
  // work queue; GET /runs/:id/bundle performs the atomic claim.
  if (c.req.query("unclaimed") === "true") {
    sql += " AND status = 'running' AND claimed_by IS NULL";
  }
  sql += " ORDER BY started_at DESC LIMIT ?";
  args.push(Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500));
  const rows = (await db.all(sql, args as any)) as RunRow[];
  // Same redaction as GET /runs/:id — inputs/trace are write-tier only. The
  // nestsApp gate guarantees read here; nestPermission carries the tier.
  const canSeeDetail =
    permissionLevel(c.get("nestPermission")) >= permissionLevel("write");
  return c.json({
    count: rows.length,
    runs: rows.map((r) => ({
      ...r,
      inputs: canSeeDetail ? safeJson(r.inputs) : null,
      trace: canSeeDetail ? safeJson(r.trace) : null,
    })),
  });
});

// ─── Top-level /runs/:id routes (runner-facing) ─────────────────────────
// Auth: resolve the run's nest, then enforce nest permission — write for
// stepping/closing, read for viewing (with NL rationale redacted at read
// tier, same posture as changes-since deleted[]).

export const runDetailRoutes = new Hono<AuthEnv>();

async function loadRunWithPermission(
  c: any,
  runId: string,
  required: "read" | "write",
): Promise<RunRow> {
  const run = (await getDb().get("SELECT * FROM runs WHERE id = ?", [
    runId,
  ])) as RunRow | undefined;
  if (!run) throw new NotFoundError("Run not found");

  // These /runs/:id routes sit OUTSIDE the nestsApp gate, so the checks that
  // gate does for every other nest-scoped route must be replicated here —
  // otherwise a nest-scoped key (or a suspended/unlicensed server) could act
  // on runs it shouldn't. This route family is the one handed to external
  // runners, so the guarantee matters most here.
  const nestScope = c.get("nestScope");
  if (nestScope && nestScope !== run.nest_id) {
    // Mirror the nest gate's message so scoped keys fail the same way everywhere.
    throw new ForbiddenError("API key not authorized for this nest");
  }
  if (required === "write") {
    if (isSuspended()) {
      throw new ForbiddenError(
        `Server suspended by PromptOwl: ${getSuspensionReason()}`,
      );
    }
    if (!getCurrentLicense()?.valid) {
      throw new ForbiddenError(
        "A valid PromptOwl license is required to write runs.",
      );
    }
  }

  const perm =
    config.AUTH_MODE === "open"
      ? "owner"
      : await resolveNestPermission(run.nest_id, c.get("userId"));
  if (permissionLevel(perm) < permissionLevel(required)) {
    // No permission at all → 404, mirroring the nest gate: hide the run's
    // existence rather than confirm it with a 403 (no cross-nest oracle).
    throw new NotFoundError("Run not found");
  }
  (c as any).set("runPermission", perm);
  return run;
}

// POST /runs/:id/steps
runDetailRoutes.post("/:id/steps", requireWorkflowPlane, async (c) => {
  const run = await loadRunWithPermission(c, c.req.param("id")!, "write");
  if (run.status !== "running") {
    throw new ConflictError(`Run is ${run.status} — steps can't be appended`);
  }
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.action !== "string" || !body.action.trim()) {
    throw new ValidationError("action is required (read|write|branch|notify|external)");
  }
  const action = body.action.trim();
  const nodeId = typeof body.node_id === "string" ? body.node_id : null;
  const edgeId = typeof body.edge_id === "string" ? body.edge_id : null;
  const detail = body.detail === undefined ? null : JSON.stringify(body.detail);
  // Bound the step log — a runaway/hostile runner can't grow it without limit.
  const stepCount = (await getDb().get(
    "SELECT COUNT(*) as c FROM run_steps WHERE run_id = ?",
    [run.id],
  )) as { c: number };
  if (stepCount.c >= config.RUN_MAX_STEPS) {
    throw new ConflictError(
      `run has reached the step limit (${config.RUN_MAX_STEPS})`,
    );
  }
  // seq is server-assigned inside a transaction (not client-supplied): the
  // ordered trace is what replay depends on, so max+insert must be atomic.
  // A UNIQUE(run_id, seq) index (migration 017) is the backstop against any
  // cross-connection race the transaction doesn't serialize.
  const db = getDb();
  let seq = 0;
  await db.transaction(async (tx) => {
    const last = (await tx.get(
      "SELECT MAX(seq) as m FROM run_steps WHERE run_id = ?",
      [run.id],
    )) as { m: number | null };
    seq = (last.m ?? 0) + 1;
    await tx.run(
      `INSERT INTO run_steps (run_id, seq, node_id, edge_id, action, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [run.id, seq, nodeId, edgeId, action, detail, new Date().toISOString()],
    );
  });
  return c.json({ ok: true, seq }, 201);
});

// PATCH /runs/:id — close or update status/trace
runDetailRoutes.patch("/:id", requireWorkflowPlane, async (c) => {
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
  // Cancelling stops the whole branch — sub-agents under this run go too.
  if (status === "cancelled") await cancelDescendants(run.id);
  if (status === "failed") {
    const err =
      body.trace && typeof body.trace === "object"
        ? String((body.trace as any).error ?? "").slice(0, 200)
        : "";
    void dispatchEvent({
      kind: "run_failed",
      nestId: run.nest_id,
      subjectId: run.id,
      actor: run.triggered_by,
      message: `Run of *${run.agent_node}* failed${err ? ` — ${err}` : ""}`,
    });
  }
  return c.json({ ok: true, status });
});

// GET /runs/:id/bundle — re-hand the executable bundle for an EXISTING run.
// This is how a polling runner claims server-created runs (interval
// scheduler, UI trigger): list unclaimed running runs, fetch each bundle,
// walk it, close it. Write-gated: the bundle carries env values.
runDetailRoutes.get("/:id/bundle", requireWorkflowPlane, async (c) => {
  const run = await loadRunWithPermission(c, c.req.param("id")!, "write");
  if (run.status !== "running") {
    throw new ConflictError(`Run is ${run.status} — nothing to execute`);
  }
  // Atomic claim: first caller wins, everyone else 409s. This is what keeps
  // two pollers from double-executing the same run (duplicate tool calls,
  // duplicate write-backs). rows-affected is the arbiter, not a pre-read.
  const claimer = await resolveCallerEmail(c.get("userId"));
  const res = await getDb().run(
    `UPDATE runs SET claimed_by = ?, claimed_at = ?
      WHERE id = ? AND claimed_by IS NULL`,
    [claimer, new Date().toISOString(), run.id],
  );
  if (!res.changes) {
    throw new ConflictError("Run already claimed by another runner");
  }
  const bundle = await buildRunBundle(run.nest_id, run.agent_node);
  return c.json({
    run_id: run.id,
    parent_run_id: run.parent_run_id,
    depth: run.depth,
    inputs: safeJson(run.inputs),
    ...bundle,
  });
});

// GET /runs/:id — full trace; NL rationales redacted below write tier.
runDetailRoutes.get("/:id", requireWorkflowPlane, async (c) => {
  const run = await loadRunWithPermission(c, c.req.param("id")!, "read");
  const canSeeDetail =
    permissionLevel((c as any).get("runPermission")) >=
    permissionLevel("write");
  const steps = (await getDb().all(
    "SELECT seq, node_id, edge_id, action, detail, at FROM run_steps WHERE run_id = ? ORDER BY seq",
    [run.id],
  )) as Array<{ seq: number; node_id: string | null; edge_id: string | null; action: string; detail: string | null; at: string }>;
  // inputs + trace are as sensitive as step detail (closing rationale,
  // trigger payload) — gate them on the same write tier, not just detail.
  return c.json({
    run: {
      ...run,
      inputs: canSeeDetail ? safeJson(run.inputs) : null,
      trace: canSeeDetail ? safeJson(run.trace) : null,
    },
    steps: steps.map((s) => ({
      ...s,
      detail: canSeeDetail ? safeJson(s.detail) : null,
    })),
  });
});
