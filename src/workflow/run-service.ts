/**
 * Run service — the executable core of the workflow plane ("turing" track),
 * shared by the REST routes (src/workflow/run-routes.ts) and the MCP tools
 * (src/mcp/workflow-tools.ts) so the two surfaces can't drift.
 *
 * The server never executes anything: `triggerRun` hands an external runner
 * the full bundle (agent body + reachable flow subgraph + referenced glossary
 * definitions), and the runner reports back via `appendRunStep`/`closeRun`.
 *
 * These functions are permission-agnostic — every caller resolves the nest,
 * the caller's read/write tier, suspension and license BEFORE calling in. The
 * REST side does it in loadRunWithPermission + the nestsApp gate; the MCP side
 * does it in workflow-tools. Keeping auth in the callers keeps this module a
 * pure data layer.
 */
import { v4 as uuid } from "uuid";
import type { NestStorage } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { ValidationError, NotFoundError, ConflictError, ForbiddenError } from "../shared/errors.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { safeJson } from "../shared/json.js";
import { standingBlockFor, standingRefs, type StandingRef } from "../governance/always-include-service.js";
import { CodedError } from "../shared/errors.js";
import { parseStepDetail } from "./agent-event-schema.js";
import { idempotencyConflict, isUniqueViolation, VERDICT_RANK } from "./agent-event-schema.js";

export const RUNNABLE_TYPES = ["agent", "skill"];

export { safeJson };

export interface RunRow {
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

/** Flow-edge subgraph reachable from the agent node (BFS, directed). */
export async function flowSubgraph(nestId: string, agentNode: string) {
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
export async function referencedDefinitions(
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
  try {
    const db = getDb();
    // One batched lookup rather than a SELECT per term — the trigger path is
    // what an external runner blocks on, so keep it a single round-trip.
    const list = [...terms];
    const placeholders = list.map(() => "LOWER(?)").join(", ");
    const rows = (await db.all(
      `SELECT term, definition, linked_tag FROM definitions
        WHERE nest_id = ? AND LOWER(term) IN (${placeholders})`,
      [nestId, ...list],
    )) as unknown[];
    return rows;
  } catch {
    /* definitions table not on this deployment yet — bundle ships without */
    return [];
  }
}

/**
 * Sub-agent recursion guard (FEATURE_SUBAGENT_RUNS). Given a claimed parent
 * run, validate it and return {depth}. Enforces:
 *   - parent exists, same nest, still running (can't graft onto a closed run)
 *   - depth ≤ SUBAGENT_MAX_DEPTH (finite tree = haltable)
 *   - re-entrancy: the child agent isn't already anywhere in the ancestor
 *     chain (agent A→B→A would loop forever; the per-nest flow DAG guard
 *     can't see across run boundaries, so this is the cross-run cycle check)
 *   - fan-out ≤ SUBAGENT_MAX_CHILDREN (depth bounds height, this bounds width)
 * Gated: with the flag off, ANY parent_run_id is rejected. Throws
 * ValidationError / NotFoundError / ForbiddenError / ConflictError.
 */
export async function resolveParentRun(
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
  let cursor: string | null = parentRunId;
  let parentDepth = -1;
  // Walk the ancestor chain to the root. The depth cap also bounds this walk,
  // so a corrupted chain can't loop unbounded.
  for (let i = 0; i <= config.SUBAGENT_MAX_DEPTH + 1; i++) {
    if (!cursor) break;
    const row = (await db.get(
      "SELECT id, nest_id, agent_node, status, depth, parent_run_id FROM runs WHERE id = ?",
      [cursor],
    )) as
      | { id: string; nest_id: string; agent_node: string; status: string; depth: number; parent_run_id: string | null }
      | undefined;
    // Cross-nest parent and nonexistent parent BOTH surface as 404: never let a
    // write-tier caller use the status code as an oracle for whether an
    // arbitrary run id exists in some other nest (same posture as
    // loadRunWithPermission / loadNestRun).
    if (!row || row.nest_id !== nestId) {
      throw new NotFoundError(`Parent run not found: ${cursor}`);
    }
    if (cursor === parentRunId && row.status !== "running") {
      throw new ConflictError(
        `Parent run is ${row.status} — cannot spawn a sub-agent under a closed run`,
      );
    }
    // Re-entrancy: the child agent must not appear anywhere in the ancestor
    // chain (agent A→B→A would loop forever; the per-nest flow DAG guard can't
    // see across run boundaries). Each ancestor's own agent_node is checked as
    // we walk, so a separate "seen" set would be redundant.
    if (row.agent_node === childAgent) {
      throw new ConflictError(
        `re-entrancy: "${childAgent}" is already running in this call chain — sub-agent recursion must be acyclic`,
      );
    }
    if (cursor === parentRunId) parentDepth = row.depth;
    cursor = row.parent_run_id;
  }
  const depth = parentDepth + 1;
  if (depth > config.SUBAGENT_MAX_DEPTH) {
    throw new ForbiddenError(
      `sub-agent depth ${depth} exceeds the limit of ${config.SUBAGENT_MAX_DEPTH}`,
    );
  }
  // The fan-out cap (SUBAGENT_MAX_CHILDREN) that bounds tree WIDTH is enforced
  // in triggerRun, inside the same transaction as the child INSERT — counting
  // here would be a TOCTOU check (concurrent spawns could both pass it before
  // either row lands). Depth and re-entrancy above are chain-shape invariants
  // that don't race with sibling inserts, so they stay here.
  return { depth };
}

/** What makes two run starts "the same request" for a replay. */
export interface RunRequestShape {
  agentNode: string;
  inputs: string | null;
  externalRef: string | null;
  source: string;
  parentRunId: string | null;
  /** Only compared when the caller set it. */
  startedAt: string | null;
}

export type StoredRun = RunRow & {
  source?: string | null;
  external_ref?: string | null;
  idempotency_key?: string | null;
  claimed_by?: string | null;
};

/**
 * The run an earlier call with this key created, or null. Throws 409
 * `idempotency_conflict` when the key was used for a different request.
 */
export async function replayableRun(nestId: string, key: string, req: RunRequestShape): Promise<StoredRun | null> {
  const row = (await getDb().get("SELECT * FROM runs WHERE nest_id = ? AND idempotency_key = ?", [nestId, key])) as
    | StoredRun
    | undefined;
  if (!row) return null;
  const same =
    row.agent_node === req.agentNode &&
    (row.inputs ?? null) === req.inputs &&
    (row.external_ref ?? null) === req.externalRef &&
    (row.source ?? "runner") === req.source &&
    (row.parent_run_id ?? null) === req.parentRunId &&
    (req.startedAt === null || row.started_at === req.startedAt);
  if (!same) throw idempotencyConflict("run");
  return row;
}

/** Load one run row (no permission check — the caller gates). */
export async function loadRun(runId: string): Promise<RunRow | undefined> {
  return (await getDb().get("SELECT * FROM runs WHERE id = ?", [runId])) as
    | RunRow
    | undefined;
}

export interface RunBundle {
  run_id: string;
  parent_run_id: string | null;
  depth: number;
  agent: {
    id: string;
    title: string;
    type: string;
    schedule: unknown;
    /** The runner model this agent asked for (metadata.model), or null. */
    model: string | null;
    content: string;
  };
  edges: Awaited<ReturnType<typeof flowSubgraph>>;
  definitions: unknown[];
  /** The nest's always-include documents, rendered for the runner's system
   *  prompt, and which ones they are (CU-wdqcq05rn0). */
  standing_instructions: { text: string; documents: StandingRef[]; overflow: StandingRef[] };
  trace_hint: { retrieval: string; steps: string };
}

/**
 * Create a run record and return the executable bundle in one shot.
 * `triggeredBy` MUST be derived from auth by the caller (never client-supplied)
 * — it's the accountability field. Throws NotFoundError / ValidationError.
 */
export async function triggerRun(opts: {
  nestId: string;
  agentNode: string;
  inputs: unknown;
  triggeredBy: string;
  storage: NestStorage;
  parentRunId?: unknown;
  /** The caller's user id: the standing instructions are what they may read. */
  userId: string;
  /** Agent event API (po-1186): one run per (nest, key); a repeat replays it. */
  idempotencyKey?: string | null;
  externalRef?: string | null;
}): Promise<RunBundle & { idempotent_replay?: true }> {
  const { nestId, inputs, triggeredBy, storage } = opts;
  // SECURITY: agentNode is caller-supplied and untrusted (the MCP workflow_run
  // tool passes `args.agent` straight through). Validate containment BEFORE it
  // reaches storage.readDocument — the same chokepoint the REST route and edge
  // creation use — or a `../otherNest/nodes/secret` id reads another tenant's
  // file. Doing it here covers every surface, not just REST. (See node-id.ts.)
  const agentNode = assertSafeNodeId(opts.agentNode);
  let doc;
  try {
    doc = await storage.readDocument(agentNode);
  } catch {
    throw new NotFoundError(`Agent node not found: ${agentNode}`);
  }
  const nodeType = (doc.frontmatter.type as string) || "document";
  if (!RUNNABLE_TYPES.includes(nodeType)) {
    throw new ValidationError(
      `"${agentNode}" is type "${nodeType}" — only agent/skill nodes are runnable`,
    );
  }

  // Sub-agent (nested) run? Validate the parent chain before creating anything
  // — the guard bounds depth, fan-out, and cross-run cycles (and is the flag
  // gate). A plain top-level run leaves parent null / depth 0.
  let parentRunId: string | null = null;
  let depth = 0;
  if (opts.parentRunId !== undefined && opts.parentRunId !== null) {
    if (typeof opts.parentRunId !== "string") {
      throw new ValidationError("parent_run_id must be a string");
    }
    ({ depth } = await resolveParentRun(nestId, opts.parentRunId, agentNode));
    parentRunId = opts.parentRunId;
  }

  const edges = await flowSubgraph(nestId, agentNode);
  const definitions = await referencedDefinitions(nestId, edges);
  const standing = await standingBlockFor(nestId, { userId: opts.userId, userEmail: triggeredBy });

  const idemKey = opts.idempotencyKey ?? null;
  const req: RunRequestShape = {
    agentNode,
    inputs: inputs === undefined ? null : JSON.stringify(inputs),
    externalRef: opts.externalRef ?? null,
    source: "runner",
    parentRunId,
    startedAt: null,
  };
  let id = `run_${uuid()}`;
  let replay = false;
  const prior = idemKey ? await replayableRun(nestId, idemKey, req) : null;
  if (prior) {
    id = prior.id;
    replay = true;
  }
  const db = getDb();
  if (!replay) try { await db.transaction(async (tx) => {
    // Fan-out cap, enforced atomically against concurrent sibling spawns.
    // Depth bounds the tree's HEIGHT; this bounds its WIDTH — together they cap
    // total tree size so a runner can't fork-bomb the DB. The count+INSERT must
    // be one atomic unit or two concurrent children can both read the same
    // pre-insert count and both pass. On Postgres, lock the parent row first
    // (FOR UPDATE) so those two transactions serialise; SQLite already
    // serialises writers (BEGIN IMMEDIATE), so the pair is atomic there.
    if (parentRunId) {
      if (db.dialect === "postgres") {
        await tx.get("SELECT id FROM runs WHERE id = ? FOR UPDATE", [parentRunId]);
      }
      const kids = (await tx.get(
        "SELECT COUNT(*) as c FROM runs WHERE parent_run_id = ?",
        [parentRunId],
      )) as { c: number | string };
      if (Number(kids.c) >= config.SUBAGENT_MAX_CHILDREN) {
        throw new ForbiddenError(
          `parent run already has ${kids.c} children (limit ${config.SUBAGENT_MAX_CHILDREN})`,
        );
      }
    }
    await tx.run(
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
        idemKey,
        req.externalRef,
      ],
    );
  }); } catch (err) {
    // A concurrent start with the same key won the unique index: replay it.
    const winner = idemKey && isUniqueViolation(err) ? await replayableRun(nestId, idemKey, req) : null;
    if (!winner) throw err;
    id = winner.id;
    replay = true;
  }

  return {
    ...(replay ? { idempotent_replay: true as const } : {}),
    run_id: id,
    parent_run_id: parentRunId,
    depth,
    agent: {
      id: agentNode,
      title: String(doc.frontmatter.title ?? agentNode),
      type: nodeType,
      schedule: (doc.frontmatter.metadata as any)?.schedule ?? null,
      model:
        (doc.frontmatter.metadata as any)?.model != null
          ? String((doc.frontmatter.metadata as any).model)
          : null,
      content: doc.body || "",
    },
    edges,
    definitions,
    standing_instructions: { text: standing.text, ...standingRefs(standing.set) },
    trace_hint: {
      retrieval:
        "POST /context is deterministic — record selector+hops per read so the run replays to the identical read-set",
      steps: "POST /runs/{run_id}/steps per action; PATCH /runs/{run_id} to close",
    },
  };
}

const STEP_ACTIONS = ["read", "write", "branch", "notify", "external", "decision", "proposal", "outcome"];

/** Verdict precedence: a run's ledger verdict is its strongest decision. */
const VERDICT_RANK_SQL = (col: string) =>
  `CASE ${col} WHEN 'escalate' THEN 4 WHEN 'propose' THEN 3 WHEN 'act' THEN 2 WHEN 'no_op' THEN 1 ELSE 0 END`;

/**
 * Append a step to a run. seq is server-assigned inside a transaction (never
 * client-supplied): the ordered trace is what replay depends on, so
 * status-recheck + max + insert must be atomic. Re-reading status inside the
 * tx closes the window where a concurrent close could terminate the run after
 * the caller's earlier read — a step must never land on a closed run. A
 * UNIQUE(run_id, seq) index (migration 017) backstops the seq assignment. The
 * per-run step count is capped at RUN_MAX_STEPS (checked inside the same tx) so
 * a runaway runner can't grow one run's trace without bound.
 *
 * Agent event API (po-1186): the typed actions `decision`, `proposal` and
 * `outcome` have a validated `detail` (422 naming the field). A decision
 * raises the run's ledger verdict (strongest wins) in the same transaction; a
 * proposal must name a review in the run's own nest and back-links it
 * (review_requests.run_id). `clientKey` makes the append idempotent per
 * (run, key): a repeat returns the original seq with idempotent_replay.
 * Throws ValidationError / ConflictError / CodedError(409/422).
 */
export async function appendRunStep(
  runId: string,
  input: { action?: unknown; node_id?: unknown; edge_id?: unknown; detail?: unknown },
  opts: { clientKey?: string | null; anyAction?: boolean } = {},
): Promise<{ seq: number; idempotent_replay?: true }> {
  if (typeof input.action !== "string" || !input.action.trim()) {
    throw new ValidationError("action is required (read|write|branch|notify|external)");
  }
  const action = input.action.trim();
  // REST historically accepted any action label; MCP the fixed set. Typed
  // actions are validated on both.
  if (!opts.anyAction && !STEP_ACTIONS.includes(action)) {
    throw new ValidationError(
      "action must be read | write | branch | notify | external | decision | proposal | outcome",
    );
  }
  const parsedDetail = parseStepDetail(action, input.detail);
  const nodeId = typeof input.node_id === "string" ? input.node_id : null;
  const edgeId = typeof input.edge_id === "string" ? input.edge_id : null;
  const detail = parsedDetail === undefined ? null : JSON.stringify(parsedDetail);
  const clientKey = opts.clientKey ?? null;

  const db = getDb();
  const replayOf = async (): Promise<{ seq: number; idempotent_replay: true } | null> => {
    if (!clientKey) return null;
    const prior = (await db.get(
      "SELECT seq, action, node_id, edge_id, detail FROM run_steps WHERE run_id = ? AND client_key = ?",
      [runId, clientKey],
    )) as { seq: number; action: string; node_id: string | null; edge_id: string | null; detail: string | null } | undefined;
    if (!prior) return null;
    if (prior.action !== action || prior.node_id !== nodeId || prior.edge_id !== edgeId || prior.detail !== detail) {
      throw idempotencyConflict("step");
    }
    return { seq: Number(prior.seq), idempotent_replay: true };
  };
  const early = await replayOf();
  if (early) return early;

  // A proposal step claims a review: it must be one in the run's own nest.
  if (action === "proposal") {
    const reviewId = (parsedDetail as { review_id: string }).review_id;
    const ok = await db.get(
      // Only a review this run's own credential opened: an agent can't claim
      // a person's (or another agent's) review as its proposal.
      "SELECT 1 AS x FROM review_requests rr JOIN runs r ON r.nest_id = rr.nest_id WHERE r.id = ? AND rr.id = ? AND LOWER(rr.requested_by) = LOWER(r.triggered_by)",
      [runId, reviewId],
    );
    if (!ok) {
      throw new CodedError(422, "detail.review_id: no review with that id opened by this run's credential in this nest", "invalid_field", {
        field: "detail.review_id",
      });
    }
  }

  let seq = 0;
  try {
    await db.transaction(async (tx) => {
      const cur = (await tx.get("SELECT status FROM runs WHERE id = ?", [runId])) as
        | { status: string }
        | undefined;
      if (!cur) throw new NotFoundError("Run not found");
      if (cur.status !== "running") {
        throw new ConflictError(
          `Run is ${cur.status} — steps can't be appended`,
        );
      }
      const last = (await tx.get(
        "SELECT MAX(seq) as m FROM run_steps WHERE run_id = ?",
        [runId],
      )) as { m: number | null };
      seq = (Number(last.m) || 0) + 1;
      // Hard cap on the step log so a runaway/hostile runner can't grow a single
      // run's trace unbounded. Checked inside the tx alongside the seq assignment
      // so the bound holds under concurrent appends.
      if (seq > config.RUN_MAX_STEPS) {
        throw new ConflictError(
          `Run has reached the step limit of ${config.RUN_MAX_STEPS} — no more steps can be appended`,
        );
      }
      await tx.run(
        `INSERT INTO run_steps (run_id, seq, node_id, edge_id, action, detail, at, client_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [runId, seq, nodeId, edgeId, action, detail, new Date().toISOString(), clientKey],
      );
      if (action === "decision") {
        const d = parsedDetail as { verdict: string; reason_code: string };
        await tx.run(
          `UPDATE runs SET verdict = ?, reason_code = ?
            WHERE id = ? AND ${VERDICT_RANK_SQL("verdict")} <= ${VERDICT_RANK[d.verdict] ?? 0}`,
          [d.verdict, d.reason_code, runId],
        );
      }
    });
  } catch (err) {
    // Two concurrent appends with one key: the unique index admits one; the
    // other replays it (or 409s on a different body).
    if (clientKey && isUniqueViolation(err)) {
      const r = await replayOf();
      if (r) return r;
    }
    throw err;
  }
  if (action === "proposal") await linkRunArtifacts(runId, parsedDetail);
  return { seq };
}

/**
 * Stamp the run's id on what a step produced, so the review, comment or access
 * request can link back to its trace. Keys read from the step detail:
 * `review_id`, `thread_id` (every comment in that new thread) and
 * `access_request_id`. Only rows in the run's own nest that carry no run yet
 * are touched, so a step can't claim someone else's row or re-point one.
 * Best-effort: the link is a convenience, never a reason to fail the step.
 */
export async function linkRunArtifacts(runId: string, detail: unknown): Promise<void> {
  if (!detail || typeof detail !== "object") return;
  const d = detail as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);
  const reviewId = id(d.review_id);
  const threadId = id(d.thread_id);
  const accessId = id(d.access_request_id);
  if (!reviewId && !threadId && !accessId) return;
  const db = getDb();
  try {
    const run = (await db.get("SELECT nest_id FROM runs WHERE id = ?", [runId])) as
      | { nest_id: string }
      | undefined;
    if (!run) return;
    if (reviewId) {
      await db.run(
        "UPDATE review_requests SET run_id = ? WHERE id = ? AND nest_id = ? AND run_id IS NULL",
        [runId, reviewId, run.nest_id],
      );
    }
    if (threadId) {
      await db.run(
        `UPDATE annotation_comments SET run_id = ?
          WHERE thread_id = ? AND run_id IS NULL
            AND thread_id IN (SELECT id FROM annotation_threads WHERE id = ? AND nest_id = ?)`,
        [runId, threadId, threadId, run.nest_id],
      );
    }
    if (accessId) {
      await db.run(
        "UPDATE access_requests SET run_id = ? WHERE id = ? AND nest_id = ? AND run_id IS NULL",
        [runId, accessId, run.nest_id],
      );
    }
  } catch (err) {
    console.warn(`[runs] could not link artifacts to run ${runId}:`, err);
  }
}

const RUN_STATUSES = ["running", "succeeded", "failed", "cancelled"];

/**
 * Cancelling a run kills the branch under it: a sub-agent whose parent is gone
 * has nothing left to report back to, and a runner that later claimed it would
 * execute work no one is waiting for. Walk the tree level by level and cancel
 * every still-running descendant. The parent chain is acyclic (spawn guards
 * reject re-entrancy), but the loop is bounded anyway. Returns how many were
 * cancelled.
 */
export async function cancelDescendants(runId: string): Promise<number> {
  const db = getDb();
  const at = new Date().toISOString();
  const trace = JSON.stringify({ error: "Parent run cancelled" });
  let frontier = [runId];
  let cancelled = 0;
  for (let depth = 0; frontier.length && depth < 64; depth++) {
    const ph = frontier.map(() => "?").join(",");
    const kids = (await db.all(
      `SELECT id FROM runs WHERE parent_run_id IN (${ph}) AND status = 'running'`,
      frontier as any,
    )) as Array<{ id: string }>;
    if (!kids.length) break;
    frontier = kids.map((k) => k.id);
    const kph = frontier.map(() => "?").join(",");
    await db.run(
      `UPDATE runs SET status = 'cancelled', trace = COALESCE(trace, ?), finished_at = ?
        WHERE id IN (${kph}) AND status = 'running'`,
      [trace, at, ...frontier] as any,
    );
    cancelled += frontier.length;
  }
  return cancelled;
}

/**
 * Close or update a run's status/trace. Compare-and-swap on `status =
 * 'running'` means two concurrent closers can't both win: exactly one mutates
 * the row, the loser gets a ConflictError instead of a silent last-write-wins.
 * "Terminal is final." Throws ValidationError / NotFoundError / ConflictError.
 */
export async function closeRun(
  runId: string,
  input: { status?: unknown; trace?: unknown },
): Promise<{ status: string }> {
  const status = input.status;
  if (typeof status !== "string" || !RUN_STATUSES.includes(status)) {
    throw new ValidationError("status must be running | succeeded | failed | cancelled");
  }
  const terminal = status !== "running";
  const res = await getDb().run(
    `UPDATE runs SET status = ?, trace = COALESCE(?, trace), finished_at = ?
      WHERE id = ? AND status = 'running'`,
    [
      status,
      input.trace === undefined ? null : JSON.stringify(input.trace),
      terminal ? new Date().toISOString() : null,
      runId,
    ],
  );
  if (res.changes === 0) {
    // Either the run doesn't exist or it's already terminal. Disambiguate so
    // the caller returns the right 404-vs-409.
    const run = await loadRun(runId);
    if (!run) throw new NotFoundError("Run not found");
    throw new ConflictError("Run already terminal — status can't be changed");
  }
  if (status === "cancelled") await cancelDescendants(runId);
  if (status === "failed") {
    const run = await loadRun(runId);
    if (run) announceRunFailed(run, input.trace);
  }
  return { status };
}

/**
 * Tell the nest's channels a run failed. Every way a run can fail goes
 * through here — a runner's PATCH, the MCP close tool, and runs the server
 * executes itself (metacognition), which used to fail silently.
 * Fire-and-forget: an outage in a channel never fails the close.
 */
export function announceRunFailed(
  run: { id: string; nest_id: string; agent_node: string; triggered_by: string },
  trace: unknown,
): void {
  const err =
    trace && typeof trace === "object" ? String((trace as { error?: unknown }).error ?? "").slice(0, 200) : "";
  void import("../notify/dispatch.js")
    .then(({ dispatchEvent }) =>
      dispatchEvent({
        kind: "run_failed",
        nestId: run.nest_id,
        subjectId: run.id,
        actor: run.triggered_by,
        message: `Run of *${run.agent_node}* failed${err ? ` — ${err}` : ""}`,
      }),
    )
    .catch((e) => console.warn("[runs] run_failed notification failed", (e as Error)?.message));
}

/**
 * Full trace for one run. `canSeeDetail` (write tier) gates the freeform
 * payloads — run inputs, run trace, and each step's detail — same redaction
 * posture across REST and MCP. Below it, those null out but existence, agent,
 * status, timing and step order stay visible.
 */
export async function getRunTrace(
  run: RunRow,
  opts: { canSeeDetail: boolean },
): Promise<{ run: unknown; steps: unknown[] }> {
  const { canSeeDetail } = opts;
  const steps = (await getDb().all(
    "SELECT seq, node_id, edge_id, action, detail, at FROM run_steps WHERE run_id = ? ORDER BY seq",
    [run.id],
  )) as Array<{
    seq: number; node_id: string | null; edge_id: string | null;
    action: string; detail: string | null; at: string;
  }>;
  return {
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
  };
}

/** List runs for a nest, filtered by agent/status, redacted below write tier. */
export async function listRuns(
  nestId: string,
  opts: { agent?: string; status?: string; limit?: number; canSeeDetail: boolean },
): Promise<{ count: number; runs: unknown[] }> {
  const db = getDb();
  let sql = "SELECT * FROM runs WHERE nest_id = ?";
  const args: unknown[] = [nestId];
  if (opts.agent) {
    sql += " AND agent_node = ?";
    args.push(opts.agent);
  }
  if (opts.status) {
    sql += " AND status = ?";
    args.push(opts.status);
  }
  sql += " ORDER BY started_at DESC LIMIT ?";
  args.push(Math.min(Math.max(Number(opts.limit) || 50, 1), 500));
  const rows = (await db.all(sql, args as any)) as RunRow[];
  return {
    count: rows.length,
    runs: rows.map((r) => ({
      ...r,
      inputs: opts.canSeeDetail ? safeJson(r.inputs) : null,
      idempotency_key: opts.canSeeDetail ? ((r as { idempotency_key?: string | null }).idempotency_key ?? null) : null,
      trace: opts.canSeeDetail ? safeJson(r.trace) : null,
    })),
  };
}
