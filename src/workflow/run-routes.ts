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
import { ValidationError, NotFoundError, ConflictError, ForbiddenError, CodedError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { standingBlockFor, standingRefs } from "../governance/always-include-service.js";
import { resolveNestPermission, permissionLevel } from "../shared/access.js";
import { isSuspended, getSuspensionReason, getOfflineLock } from "../auth/license.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { requireWorkflowPlane } from "./edge-type-routes.js";
import { appendRunStep, replayableRun, type RunRequestShape } from "./run-service.js";
import {
  AGENT_API_VERSION,
  AgentRunStartBody,
  AgentRunStepBody,
  isUniqueViolation,
  parseIdempotencyKey,
  parseOr422,
} from "./agent-event-schema.js";
import {
  assertExternalWriteCredential,
  closeRunIdempotent,
  consumeAgentRate,
  startReportRun,
} from "./agent-events.js";
import { envValues } from "./env-routes.js";
import { NEUTRAL_READ_ONLY, canSeeLicenseDetail, offlineLockMessage } from "../auth/license-copy.js";
import { FREE_TIER_EXCEEDED_MESSAGE, writesAllowed } from "../auth/free-tier.js";
import { SERVER_CLAIM, getAgent } from "../metacognition/store.js";
import { requireMetacognitionAdmin } from "../metacognition/manage.js";

const RUNNABLE_TYPES = ["agent", "skill"];

interface RunRow {
  id: string;
  nest_id: string;
  agent_node: string;
  triggered_by: string;
  status: string;
  claimed_by?: string | null;
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
async function buildRunBundle(
  nestId: string,
  agentNode: string,
  /** Who receives the bundle — the standing instructions are what THEY may read. */
  caller: { userId: string; userEmail: string },
) {
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
  // (a nest's own key with byok, else PromptOwl's gateway). The bundle requires write
  // permission to obtain, and this is the ONLY surface that returns full
  // values (the /env routes mask them).
  const env = await envValues(nestId);
  // The nest's always-include documents (CU-wdqcq05rn0): the runner puts
  // `text` in its model's system prompt, as Hootie and metacognition do.
  const standing = await standingBlockFor(nestId, caller);

  return {
    agent: {
      id: agentNode,
      title: String(doc.frontmatter.title ?? agentNode),
      type: nodeType,
      schedule: (doc.frontmatter.metadata as any)?.schedule ?? null,
      // The runner model this agent asked for; null → the runner's default.
      model:
        (doc.frontmatter.metadata as any)?.model != null
          ? String((doc.frontmatter.metadata as any).model)
          : null,
      content: doc.body || "",
    },
    edges,
    node_types,
    tools,
    env,
    definitions,
    standing_instructions: { text: standing.text, ...standingRefs(standing.set) },
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
  const raw = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  // Agent event API (po-1186 E2): report_only / started_at / external_ref
  // are validated with the schema MCP shares; a bad one is a 422 naming it.
  const body = parseOr422(AgentRunStartBody, raw && typeof raw === "object" ? raw : {});
  const idempotencyKey = parseIdempotencyKey(c.req.header("Idempotency-Key"));
  consumeAgentRate("runs", { apiKeyId: c.get("apiKeyId"), userId: c.get("userId") });

  if (body.report_only === true) {
    if (body.parent_run_id !== undefined && body.parent_run_id !== null) {
      throw new CodedError(422, "parent_run_id: a report-only run can't be a sub-agent run", "invalid_field", {
        field: "parent_run_id",
      });
    }
    await assertExternalWriteCredential({
      nestId,
      apiKeyId: c.get("apiKeyId") ?? null,
      oauth: c.get("oauthScope") !== undefined,
    });
    const { storage } = await engineCache.get(nestId);
    const out = await startReportRun({
      nestId,
      agentNode,
      storage,
      triggeredBy: await resolveCallerEmail(c.get("userId")),
      inputs: body.inputs,
      startedAt: body.started_at,
      externalRef: body.external_ref,
      idempotencyKey,
    });
    return c.json(out, out.idempotent_replay ? 200 : 201);
  }

  // A metacognition agent runs in this server, not in an external runner:
  // the trigger starts it here and hands out no bundle (no env values, no
  // instructions) — there is nothing for a caller to execute.
  if (config.FEATURE_METACOGNITION) {
    const meta = await getAgent(nestId, agentNode);
    if (meta?.enabled) {
      // Metacognition is owner/admin only, however the run is started.
      requireMetacognitionAdmin(c.get("nestPermission"));
      if (body.parent_run_id !== undefined && body.parent_run_id !== null) {
        throw new ValidationError("A metacognition agent can't run as a sub-agent");
      }
      const { startMetacognitionRun } = await import("../metacognition/service.js");
      const runId = await startMetacognitionRun({
        nestId,
        nodeId: agentNode,
        triggeredBy: await resolveCallerEmail(c.get("userId")),
        inputs: body.inputs,
      });
      return c.json({ run_id: runId, executes: "server" }, 202);
    }
  }

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

  // Derived from auth, never client-supplied — this is the accountability
  // field ("who triggered this run"), so it must be trustworthy. A scheduler
  // or external runner authenticates with its own key; that identity is the
  // honest answer.
  const triggeredBy = await resolveCallerEmail(c.get("userId"));
  const bundle = await buildRunBundle(nestId, agentNode, {
    userId: c.get("userId"),
    userEmail: triggeredBy,
  });

  // Idempotent start (po-1186): a repeat with the same key hands back the
  // same run (and a freshly built bundle) instead of creating a second one.
  const req: RunRequestShape = {
    agentNode,
    inputs: body.inputs === undefined ? null : JSON.stringify(body.inputs),
    externalRef: body.external_ref ?? null,
    source: "runner",
    parentRunId,
    startedAt: null,
  };
  let id = `run_${uuid()}`;
  let replay = false;
  const prior = idempotencyKey ? await replayableRun(nestId, idempotencyKey, req) : null;
  if (prior) {
    id = prior.id;
    replay = true;
  } else {
    try {
      await getDb().run(
        `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, inputs, started_at, parent_run_id, depth, idempotency_key, external_ref)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
        [
          id,
          nestId,
          agentNode,
          triggeredBy,
          req.inputs,
          new Date().toISOString(),
          parentRunId,
          depth,
          idempotencyKey,
          req.externalRef,
        ],
      );
    } catch (err) {
      const winner = idempotencyKey && isUniqueViolation(err) ? await replayableRun(nestId, idempotencyKey, req) : null;
      if (!winner) throw err;
      id = winner.id;
      replay = true;
    }
  }

  return c.json(
    {
      ...(replay ? { idempotent_replay: true } : {}),
      api_version: AGENT_API_VERSION,
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
    replay ? 200 : 201,
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
      idempotency_key: canSeeDetail ? ((r as { idempotency_key?: string | null }).idempotency_key ?? null) : null,
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
  // Same rule as every other write path: writesAllowed (license or Free tier).
  if (required === "write" && !(await writesAllowed())) {
    if (!(await canSeeLicenseDetail(c.get("userId")))) {
      throw new ForbiddenError(NEUTRAL_READ_ONLY);
    }
    if (isSuspended()) {
      throw new ForbiddenError(
        `Server suspended by PromptOwl: ${getSuspensionReason()}`,
      );
    }
    const offlineSince = getOfflineLock();
    if (offlineSince) throw new ForbiddenError(offlineLockMessage(offlineSince));
    throw new ForbiddenError(FREE_TIER_EXCEEDED_MESSAGE);
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
  // A read-only key only reads, whatever its owner may do — the nest gate's
  // rule. Without it, a read key could append steps (and decision verdicts),
  // close runs, or fetch a bundle with the nest's env values.
  if (required === "write" && c.get("keyCapability") === "read") {
    throw new ForbiddenError("This API key is read-only and cannot perform write or governance actions.");
  }
  (c as any).set("runPermission", perm);
  return run;
}

// POST /runs/:id/steps
runDetailRoutes.post("/:id/steps", requireWorkflowPlane, async (c) => {
  consumeAgentRate("events", { apiKeyId: c.get("apiKeyId"), userId: c.get("userId") });
  const run = await loadRunWithPermission(c, c.req.param("id")!, "write");
  const clientKey = parseIdempotencyKey(c.req.header("Idempotency-Key"));
  // A metacognition run is executed by this server, which writes its own
  // trace. Nobody else may add to it — the trace is the agent's audit.
  if (run.claimed_by === SERVER_CLAIM) {
    throw new ConflictError("This run is executed by the server; its steps are recorded by the server");
  }
  if ((run as { source?: string }).source === "external") {
    await assertExternalWriteCredential({
      nestId: run.nest_id,
      apiKeyId: c.get("apiKeyId") ?? null,
      oauth: c.get("oauthScope") !== undefined,
    });
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => {
    throw new ValidationError("Body must be JSON");
  });
  const input = parseOr422(AgentRunStepBody, body);
  // The shared service: status re-check, seq, step cap and the typed-action
  // checks run in one transaction; a repeated Idempotency-Key replays.
  const out = await appendRunStep(run.id, input, { clientKey, anyAction: true });
  return c.json({ ok: true, ...out, api_version: AGENT_API_VERSION }, out.idempotent_replay ? 200 : 201);
});

// PATCH /runs/:id — close or update status/trace
runDetailRoutes.patch("/:id", requireWorkflowPlane, async (c) => {
  const run = await loadRunWithPermission(c, c.req.param("id")!, "write");
  const body = await c.req.json<Record<string, unknown>>().catch(() => {
    throw new ValidationError("Body must be JSON");
  });
  const status = body?.status;
  if (
    typeof status !== "string" ||
    !["running", "succeeded", "failed", "cancelled"].includes(status)
  ) {
    throw new ValidationError("status must be running | succeeded | failed | cancelled");
  }
  // Only stopping a server-executed run is a person's call; its outcome is
  // the server's to record.
  if (run.claimed_by === SERVER_CLAIM && status !== "cancelled") {
    throw new ConflictError("This run is executed by the server — it can be cancelled, not closed");
  }
  if ((run as { source?: string }).source === "external") {
    await assertExternalWriteCredential({
      nestId: run.nest_id,
      apiKeyId: c.get("apiKeyId") ?? null,
      oauth: c.get("oauthScope") !== undefined,
    });
  }
  // Compare-and-swap on the status (closeRun): the loser of a close race gets
  // the 409, and cancelling stops the whole branch only once the swap won.
  // An identical repeat of the winning close is an idempotent replay (E4).
  try {
    const out = await closeRunIdempotent(run.id, body);
    return c.json({ ok: true, ...out });
  } catch (err) {
    if (err instanceof ConflictError) {
      const now = (await getDb().get("SELECT status FROM runs WHERE id = ?", [run.id])) as
        | { status: string }
        | undefined;
      throw new ConflictError(`Run already terminal (${now?.status ?? "closed"})`);
    }
    throw err;
  }
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
  const bundle = await buildRunBundle(run.nest_id, run.agent_node, {
    userId: c.get("userId"),
    userEmail: claimer,
  });
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
      idempotency_key: canSeeDetail ? ((run as { idempotency_key?: string | null }).idempotency_key ?? null) : null,
      trace: canSeeDetail ? safeJson(run.trace) : null,
    },
    steps: steps.map((s) => ({
      ...s,
      detail: canSeeDetail ? safeJson(s.detail) : null,
    })),
  });
});
