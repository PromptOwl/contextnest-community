/**
 * MCP surface for the workflow plane ("turing" track) — lets an MCP agent
 * BUILD a workflow graph (edge types + edges) and EXECUTE it as a runner
 * (trigger a run, append steps, close it), the same operations the REST routes
 * expose. Every mutation and read goes through the SAME service/helper code the
 * routes use (run-service, edge-routes, edge-type-routes) so the two surfaces
 * can't drift.
 *
 * Gating: these definitions are only registered when FEATURE_WORKFLOW_PLANE is
 * on (see mcp/routes.ts), mirroring the REST requireWorkflowPlane 404. The
 * per-nest MCP endpoint already sits behind the nestsApp gate, so suspension,
 * license and nest-scope-key checks apply to every call here; what this module
 * adds is the read-vs-write TIER check per tool (the gate lets any read-tier
 * caller reach MCP).
 */
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { v4 as uuid } from "uuid";
import {
  resolveNestPermission,
  permissionLevel,
  type NestPermission,
} from "../shared/access.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { ForbiddenError, ValidationError, NotFoundError } from "../shared/errors.js";
import type { McpToolContext } from "./tools.js";
import {
  NOT_ENABLED,
  metacognitionEnabled,
  assertCanManageMetacognition,
  getAgentView,
  agentStatsFor,
} from "../metacognition/manage.js";
import {
  triggerRun,
  appendRunStep,
  closeRun,
  getRunTrace,
  listRuns,
  loadRun,
} from "../workflow/run-service.js";
import {
  validateCondition,
  assertNoFlowCycle,
  assertNoDuplicateEdge,
  toResponse as edgeToResponse,
  type EdgeRow,
} from "../workflow/edge-routes.js";
import {
  seedDefaultEdgeTypes,
  parseConditionSchema,
  edgeTypeToResponse,
  assertNotRelationType,
  NOT_RELATION_TYPE_SQL,
  type EdgeTypeRow,
} from "../workflow/edge-type-routes.js";

export const WORKFLOW_TOOL_DEFINITIONS = [
  // ── Execute ──────────────────────────────────────────────────────────
  {
    name: "workflow_run",
    description:
      "Trigger a governed workflow run for an agent/skill node and get the executable bundle back (agent instructions, the reachable flow-edge subgraph, and referenced glossary definitions) plus a run_id. The server does not execute — YOU are the runner: walk the edges, then report progress with workflow_run_step and finish with workflow_run_close.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Node id of the agent/skill to run" },
        inputs: { type: "object", description: "Optional caller inputs recorded on the run" },
        parent_run_id: {
          type: "string",
          description:
            "Optional: spawn this as a sub-agent run under a still-running parent (FEATURE_SUBAGENT_RUNS). Bounded by depth/fan-out and guarded against re-entrancy.",
        },
      },
      required: ["agent"],
    },
  },
  {
    name: "workflow_run_step",
    description:
      "Append one step to a run's trace after every action. seq is assigned server-side. For branch steps put the evaluated condition, result and (NL mode) rationale in detail. Fails if the run is already closed.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        action: { type: "string", description: "read | write | branch | notify | external" },
        node_id: { type: "string", description: "Node the step touched (optional)" },
        edge_id: { type: "string", description: "Edge the step followed (optional)" },
        detail: { type: "object", description: "Freeform payload: reads, condition results, rationale" },
      },
      required: ["run_id", "action"],
    },
  },
  {
    name: "workflow_run_close",
    description:
      "Close a run with a terminal status (succeeded | failed | cancelled) and an optional trace summary. Terminal is final — a second close returns a conflict.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        status: { type: "string", description: "succeeded | failed | cancelled (or running to update trace)" },
        trace: { type: "object", description: "Optional summary/totals recorded on the run" },
      },
      required: ["run_id", "status"],
    },
  },
  {
    name: "workflow_run_get",
    description:
      "Fetch one run's full trace (steps in order). Freeform payloads (inputs, trace, step detail) are redacted unless you have write access to the nest.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
  {
    name: "workflow_runs_list",
    description:
      "List runs in this nest, most recent first. Filter by agent node id and/or status (running|succeeded|failed|cancelled). " +
      "With agent_stats: true and agent set to a metacognition agent, returns that agent's track record instead — run outcomes " +
      "(succeeded/failed/timeout/skipped), tokens and estimated cost, how its proposals were judged (approval rate), comments, " +
      "the last error, and its `limit` most recent runs — over the last `days` (default 30). Owner/admin only, like the agent's page. " +
      "To list, set up, run or remove metacognition agents, use context_metacognition_list, context_metacognition_suggest, context_metacognition_preview, context_metacognition_configure, context_metacognition_run and context_metacognition_remove.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        status: { type: "string" },
        limit: { type: "number" },
        agent_stats: { type: "boolean", description: "Return the agent's activity stats (metacognition agents only)" },
        days: { type: "number", description: "agent_stats window in days, 1-365 (default 30)" },
      },
      required: [],
    },
  },
  // ── Build: edges ─────────────────────────────────────────────────────
  {
    name: "workflow_edges_list",
    description:
      "List typed edges in this nest. Optional filters: type (edge-type name or id) and node (id appearing as either endpoint).",
    inputSchema: {
      type: "object",
      properties: { type: { type: "string" }, node: { type: "string" } },
      required: [],
    },
  },
  {
    name: "workflow_edge_create",
    description:
      "Create a typed edge between two existing nodes. The edge type must already exist in the registry. Optional condition in mode structured (JSON predicate {term,op,value}; term must be a defined glossary term), nl (natural-language, judged at run time), or open. Flow-type edges must keep the graph a DAG — a cycle is rejected.",
    inputSchema: {
      type: "object",
      properties: {
        from_node: { type: "string" },
        to_node: { type: "string" },
        type: { type: "string", description: "Edge-type name or id" },
        condition_mode: { type: "string", description: "structured | nl | open" },
        condition: { type: "object", description: "Predicate object (structured) or string (nl/open)" },
        metadata: { type: "object" },
      },
      required: ["from_node", "to_node", "type"],
    },
  },
  {
    name: "workflow_edge_delete",
    description: "Delete an edge by id.",
    inputSchema: {
      type: "object",
      properties: { edge_id: { type: "string" } },
      required: ["edge_id"],
    },
  },
  // ── Build: edge types ────────────────────────────────────────────────
  {
    name: "workflow_edge_types_list",
    description:
      "List this nest's edge-type registry — the articulated vocabulary of relations. Seeds the five stock flow types on first use.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "workflow_edge_type_upsert",
    description:
      "Create or update an edge type by name (case-insensitive). name is a slug (alphanumeric-with-dashes). Set is_flow true for control-flow relations (they get DAG-validated). condition_schema is an optional {params:[string…], mode_default?} template.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        direction: { type: "string", description: "directed | undirected (default directed)" },
        is_flow: { type: "boolean" },
        condition_schema: { type: "object" },
        color: { type: "string", description: "6-digit hex, e.g. #16a34a" },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "workflow_edge_type_delete",
    description:
      "Delete an edge type by id. Refused while any edge still references it.",
    inputSchema: {
      type: "object",
      properties: { edge_type_id: { type: "string" } },
      required: ["edge_type_id"],
    },
  },
];

const WORKFLOW_TOOL_NAMES = new Set(WORKFLOW_TOOL_DEFINITIONS.map((t) => t.name));
export const isWorkflowTool = (name: string): boolean =>
  WORKFLOW_TOOL_NAMES.has(name);

/** Caller's permission on the MCP nest; open mode is owner. */
async function nestPermission(ctx: McpToolContext): Promise<NestPermission> {
  if (config.AUTH_MODE === "open") return "owner";
  return resolveNestPermission(ctx.nestId, ctx.userId);
}

/**
 * workflow_runs_list { agent_stats: true } — the MCP twin of
 * GET /nests/:id/metacognition/:node/stats, behind the same gate: the
 * metacognition flags (404 otherwise), owner/admin and no system key, and the
 * node must be a configured metacognition agent.
 */
async function agentStatsForMcp(ctx: McpToolContext, perm: NestPermission, args: Record<string, any>) {
  if (!metacognitionEnabled()) throw new NotFoundError(NOT_ENABLED);
  await assertCanManageMetacognition(ctx.nestId, ctx.userId, perm);
  if (typeof args.agent !== "string" || !args.agent.trim()) {
    throw new ValidationError("agent_stats needs agent: the metacognition agent's node id");
  }
  const nodeId = args.agent.trim();
  const whole = (k: string) => {
    const v = args[k];
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v) || v < 1) throw new ValidationError(`${k} must be a positive whole number`);
    return v as number;
  };
  // Existence first, as before: an unknown agent is "not found" before a bad window.
  await getAgentView(ctx.nestId, nodeId);
  return { stats: await agentStatsFor(ctx.nestId, nodeId, { days: whole("days"), limit: whole("limit") }) };
}

function requireTier(perm: NestPermission, tier: "read" | "write"): void {
  if (permissionLevel(perm) < permissionLevel(tier)) {
    throw new ForbiddenError(
      `This action needs ${tier} access to the nest.`,
    );
  }
}

/** Load a run and assert it belongs to the MCP nest (scope guard). */
async function loadNestRun(ctx: McpToolContext, runId: unknown) {
  if (typeof runId !== "string" || !runId) {
    throw new ValidationError("run_id is required");
  }
  const run = await loadRun(runId);
  // Same posture as REST's nestScope check: a run in another nest is simply
  // "not found" to a caller scoped to this one.
  if (!run || run.nest_id !== ctx.nestId) throw new NotFoundError("Run not found");
  return run;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

/**
 * Dispatch for every workflow-plane MCP tool. Returns a JSON string (the tool
 * result an agent runner parses). Auth errors surface as thrown errors, logged
 * by handleToolCall like any other tool.
 */
export async function runWorkflowTool(
  toolName: string,
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<string> {
  const perm = await nestPermission(ctx);

  switch (toolName) {
    // ── Execute ────────────────────────────────────────────────────────
    case "workflow_run": {
      requireTier(perm, "write");
      const triggeredBy = await resolveCallerEmail(ctx.userId);
      const bundle = await triggerRun({
        nestId: ctx.nestId,
        agentNode: String(args.agent ?? ""),
        inputs: args.inputs,
        triggeredBy,
        storage: ctx.storage,
        parentRunId: args.parent_run_id,
        userId: ctx.userId,
      });
      return json(bundle);
    }
    case "workflow_run_step": {
      requireTier(perm, "write");
      const run = await loadNestRun(ctx, args.run_id);
      const { seq } = await appendRunStep(run.id, {
        action: args.action,
        node_id: args.node_id,
        edge_id: args.edge_id,
        detail: args.detail,
      });
      return json({ ok: true, run_id: run.id, seq });
    }
    case "workflow_run_close": {
      requireTier(perm, "write");
      const run = await loadNestRun(ctx, args.run_id);
      const { status } = await closeRun(run.id, {
        status: args.status,
        trace: args.trace,
      });
      return json({ ok: true, run_id: run.id, status });
    }
    case "workflow_run_get": {
      requireTier(perm, "read");
      const run = await loadNestRun(ctx, args.run_id);
      const canSeeDetail = permissionLevel(perm) >= permissionLevel("write");
      return json(await getRunTrace(run, { canSeeDetail }));
    }
    case "workflow_runs_list": {
      if (args.agent_stats === true) return json(await agentStatsForMcp(ctx, perm, args));
      requireTier(perm, "read");
      const canSeeDetail = permissionLevel(perm) >= permissionLevel("write");
      return json(
        await listRuns(ctx.nestId, {
          agent: typeof args.agent === "string" ? args.agent : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          canSeeDetail,
        }),
      );
    }

    // ── Build: edges ───────────────────────────────────────────────────
    case "workflow_edges_list": {
      requireTier(perm, "read");
      return json(await listEdges(ctx.nestId, args.type, args.node));
    }
    case "workflow_edge_create": {
      requireTier(perm, "write");
      return json(await createEdge(ctx, args));
    }
    case "workflow_edge_delete": {
      requireTier(perm, "write");
      const id = String(args.edge_id ?? "");
      const row = await getDb().get(
        "SELECT id FROM edges WHERE id = ? AND nest_id = ?",
        [id, ctx.nestId],
      );
      if (!row) throw new NotFoundError("Edge not found");
      await getDb().run("DELETE FROM edges WHERE id = ?", [id]);
      return json({ deleted: true, edge_id: id });
    }

    // ── Build: edge types ──────────────────────────────────────────────
    case "workflow_edge_types_list": {
      requireTier(perm, "read");
      await seedDefaultEdgeTypes(ctx.nestId);
      const rows = (await getDb().all(
        `SELECT * FROM edge_types WHERE nest_id = ? AND ${NOT_RELATION_TYPE_SQL} ORDER BY LOWER(name)`,
        [ctx.nestId],
      )) as EdgeTypeRow[];
      return json({ count: rows.length, edge_types: rows.map(edgeTypeToResponse) });
    }
    case "workflow_edge_type_upsert": {
      requireTier(perm, "write");
      return json(await upsertEdgeType(ctx, args));
    }
    case "workflow_edge_type_delete": {
      requireTier(perm, "write");
      return json(await deleteEdgeType(ctx.nestId, String(args.edge_type_id ?? "")));
    }

    default:
      return json({ error: `Unknown workflow tool: ${toolName}` });
  }
}

// ── Edge helpers: mirror edge-routes.ts orchestration, reusing its exported
// validators so the hard parts (condition validation, DAG cycle guard) stay
// single-sourced. ─────────────────────────────────────────────────────────

async function listEdges(nestId: string, type: unknown, node: unknown) {
  const db = getDb();
  let sql = `SELECT e.*, t.id as t_id, t.name as t_name, t.color as t_color, t.is_flow as t_is_flow
               FROM edges e JOIN edge_types t ON t.id = e.type_id
              WHERE e.nest_id = ?`;
  const args: unknown[] = [nestId];
  if (typeof type === "string" && type.trim()) {
    sql += " AND (t.id = ? OR LOWER(t.name) = LOWER(?))";
    args.push(type.trim(), type.trim());
  }
  if (typeof node === "string" && node.trim()) {
    sql += " AND (e.from_node = ? OR e.to_node = ?)";
    args.push(node.trim(), node.trim());
  }
  sql += " ORDER BY e.created_at";
  const rows = (await db.all(sql, args as any)) as Array<
    EdgeRow & { t_id: string; t_name: string; t_color: string | null; t_is_flow: number }
  >;
  const edges = rows.map((r) =>
    edgeToResponse(r, {
      id: r.t_id,
      name: r.t_name,
      color: r.t_color,
      is_flow: r.t_is_flow,
    } as EdgeTypeRow),
  );
  return { count: edges.length, edges };
}

async function createEdge(ctx: McpToolContext, args: Record<string, any>) {
  const fromNode = typeof args.from_node === "string" ? args.from_node.trim() : "";
  const toNode = typeof args.to_node === "string" ? args.to_node.trim() : "";
  const typeRef = typeof args.type === "string" ? args.type.trim() : "";
  if (!fromNode || !toNode || !typeRef) {
    throw new ValidationError("from_node, to_node, and type are required");
  }
  assertSafeNodeId(fromNode);
  assertSafeNodeId(toNode);

  const db = getDb();
  const createdBy = await resolveCallerEmail(ctx.userId);
  await seedDefaultEdgeTypes(ctx.nestId);

  const type = (await db.get(
    "SELECT * FROM edge_types WHERE nest_id = ? AND (id = ? OR LOWER(name) = LOWER(?))",
    [ctx.nestId, typeRef, typeRef],
  )) as EdgeTypeRow | undefined;
  if (!type) {
    throw new ValidationError(
      `unknown edge type "${typeRef}" — create it first with workflow_edge_type_upsert`,
    );
  }
  assertNotRelationType(type);

  for (const nodeId of [fromNode, toNode]) {
    try {
      await ctx.storage.readDocument(nodeId);
    } catch {
      throw new ValidationError(`node not found: "${nodeId}"`);
    }
  }

  const { mode, stored } = await validateCondition(
    ctx.nestId,
    args.condition_mode,
    args.condition,
  );
  const metadata =
    args.metadata === undefined || args.metadata === null
      ? null
      : JSON.stringify(args.metadata);

  const now = new Date().toISOString();
  const id = uuid();
  await db.transaction(async (tx) => {
    await assertNoDuplicateEdge(tx, ctx.nestId, fromNode, toNode, type);
    if (type.is_flow) {
      await assertNoFlowCycle(tx, ctx.nestId, fromNode, toNode);
    }
    await tx.run(
      `INSERT INTO edges
         (id, nest_id, from_node, to_node, type_id, condition_mode, condition, metadata, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.nestId, fromNode, toNode, type.id, mode, stored, metadata, createdBy, now, now],
    );
  });
  const row = (await db.get("SELECT * FROM edges WHERE id = ?", [id])) as EdgeRow;
  return { edge: edgeToResponse(row, type) };
}

async function upsertEdgeType(ctx: McpToolContext, args: Record<string, any>) {
  if (typeof args.name !== "string" || !args.name.trim()) {
    throw new ValidationError("name is required");
  }
  if (typeof args.description !== "string" || !args.description.trim()) {
    throw new ValidationError("description (the articulation) is required");
  }
  const name = args.name.trim();
  if (name.length > 100 || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    throw new ValidationError(
      "name must be alphanumeric-with-dashes, 100 chars max (e.g. escalates-when)",
    );
  }
  const direction = String(args.direction ?? "directed");
  if (!["directed", "undirected"].includes(direction)) {
    throw new ValidationError("direction must be directed | undirected");
  }
  const conditionSchema = parseConditionSchema(args.condition_schema);
  const isFlow = args.is_flow === true ? 1 : 0;
  let color: string | null = null;
  if (args.color !== undefined && args.color !== null && args.color !== "") {
    if (typeof args.color !== "string" || !/^#[0-9a-f]{6}$/i.test(args.color)) {
      throw new ValidationError("color must be a 6-digit hex, e.g. #16a34a");
    }
    color = args.color;
  }

  const db = getDb();
  const definedBy = await resolveCallerEmail(ctx.userId);
  const now = new Date().toISOString();
  await seedDefaultEdgeTypes(ctx.nestId);

  let created = false;
  await db.transaction(async (tx) => {
    const existing = (await tx.get(
      "SELECT id FROM edge_types WHERE nest_id = ? AND LOWER(name) = LOWER(?)",
      [ctx.nestId, name],
    )) as { id: string } | undefined;
    if (existing) {
      await tx.run(
        `UPDATE edge_types SET name = ?, description = ?, direction = ?, is_flow = ?,
           condition_schema = ?, color = ?, updated_at = ? WHERE id = ?`,
        [name, args.description.trim(), direction, isFlow, conditionSchema, color, now, existing.id],
      );
    } else {
      created = true;
      await tx.run(
        `INSERT INTO edge_types
           (id, nest_id, name, description, direction, is_flow, condition_schema, color, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), ctx.nestId, name, args.description.trim(), direction, isFlow, conditionSchema, color, definedBy, now, now],
      );
    }
  });
  const row = (await db.get(
    "SELECT * FROM edge_types WHERE nest_id = ? AND LOWER(name) = LOWER(?)",
    [ctx.nestId, name],
  )) as EdgeTypeRow;
  return { created, edge_type: edgeTypeToResponse(row) };
}

async function deleteEdgeType(nestId: string, id: string) {
  await getDb().transaction(async (tx) => {
    const row = (await tx.get(
      "SELECT id, name FROM edge_types WHERE id = ? AND nest_id = ?",
      [id, nestId],
    )) as { id: string; name: string } | undefined;
    if (!row) throw new NotFoundError("Edge type not found");
    assertNotRelationType(row);
    const inUse = (await tx.get(
      "SELECT COUNT(*) as c FROM edges WHERE type_id = ?",
      [id],
    )) as { c: number };
    if (inUse.c > 0) {
      throw new ValidationError(
        `Edge type is in use by ${inUse.c} edge${inUse.c === 1 ? "" : "s"} — delete those first.`,
      );
    }
    await tx.run("DELETE FROM edge_types WHERE id = ?", [id]);
  });
  return { deleted: true, edge_type_id: id };
}
