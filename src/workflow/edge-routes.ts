/**
 * Edges — typed, condition-carrying links between nodes ("turing" track).
 * The queryable, governed layer on top of implicit wikilinks: workflows
 * (flow types, DAG-validated), lineage/ERD (derives-from, foreign-key),
 * ownership (owned-by). Feature-flagged like the registry.
 *
 * Conditions live on the edge as metadata; the mode decides who can
 * evaluate them:
 *   structured — JSON predicate {term, op, value}; term resolves against
 *                the definitions table (validation activates when that
 *                table exists — it ships in the glossary PR)
 *   nl         — natural language; an LLM runner judges at execution time
 *   open       — freeform; runner's discretion
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import type { AuthEnv } from "../auth/middleware.js";
import { getDb } from "../db/client.js";
import { engineCache } from "../nodes/engine.js";
import { ValidationError, NotFoundError, ConflictError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import {
  requireWorkflowPlane,
  seedDefaultEdgeTypes,
  type EdgeTypeRow,
} from "./edge-type-routes.js";

interface EdgeRow {
  id: string;
  nest_id: string;
  from_node: string;
  to_node: string;
  type_id: string;
  condition_mode: "structured" | "nl" | "open" | null;
  condition: string | null;
  metadata: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const safeJson = (s: string | null): unknown => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

function toResponse(e: EdgeRow, t: EdgeTypeRow) {
  return {
    id: e.id,
    from_node: e.from_node,
    to_node: e.to_node,
    type: { id: t.id, name: t.name, color: t.color, is_flow: !!t.is_flow },
    condition_mode: e.condition_mode,
    condition:
      e.condition_mode === "structured" ? safeJson(e.condition) : e.condition,
    metadata: safeJson(e.metadata),
    created_by: e.created_by,
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

/**
 * Structured conditions referencing a `term` validate against the
 * definitions table so "CAC > 500" always means the steward-articulated
 * CAC. The table ships in the glossary PR — until both are merged, the
 * check degrades to shape-only (documented in the PR).
 */
async function validateCondition(
  nestId: string,
  mode: string | undefined,
  condition: unknown,
): Promise<{ mode: string | null; stored: string | null }> {
  if (mode === undefined || mode === null) {
    if (condition !== undefined && condition !== null) {
      throw new ValidationError("condition requires condition_mode");
    }
    return { mode: null, stored: null };
  }
  if (!["structured", "nl", "open"].includes(mode as string)) {
    throw new ValidationError("condition_mode must be structured | nl | open");
  }
  if (condition === undefined || condition === null || condition === "") {
    throw new ValidationError(`condition_mode "${mode}" requires a condition`);
  }
  if (mode === "structured") {
    if (typeof condition !== "object" || Array.isArray(condition)) {
      throw new ValidationError(
        'structured condition must be an object, e.g. {"term":"CAC","op":">","value":500}',
      );
    }
    const c = condition as Record<string, unknown>;
    if (typeof c.term === "string" && c.term.trim()) {
      try {
        const row = await getDb().get(
          "SELECT id FROM definitions WHERE nest_id = ? AND LOWER(term) = LOWER(?)",
          [nestId, c.term.trim()],
        );
        if (!row) {
          throw new ValidationError(
            `structured condition references undefined term "${c.term}" — define it in the glossary first`,
          );
        }
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        /* definitions table not present on this deployment yet — shape-only */
      }
    }
    return { mode, stored: JSON.stringify(condition) };
  }
  if (typeof condition !== "string") {
    throw new ValidationError(`condition for mode "${mode}" must be a string`);
  }
  return { mode, stored: condition };
}

/** Reject a new flow edge that would close a cycle; names the path. */
/**
 * Whole-graph acyclicity check over ALL current flow edges in a nest.
 * Per-edge `assertNoFlowCycle` only guards edge *creation* while the type is
 * already flow — it can't see a cycle assembled under a NON-flow type that is
 * later flipped to `is_flow`. This is the backstop for that path (called from
 * the edge-type upsert when is_flow goes false→true). Kahn's algorithm: if any
 * node never reaches in-degree 0, the remaining subgraph contains a cycle.
 */
export async function assertFlowGraphAcyclic(
  nestId: string,
  extraFlowTypeId?: string,
): Promise<void> {
  const db = getDb();
  // Evaluate the WOULD-BE flow graph: edges under already-flow types, PLUS
  // edges under `extraFlowTypeId` (the type about to be flipped to flow), so
  // the check runs before we commit the flip.
  const rows = (await db.all(
    `SELECT e.from_node, e.to_node FROM edges e
       JOIN edge_types t ON t.id = e.type_id
      WHERE e.nest_id = ? AND (t.is_flow = 1 OR t.id = ?)`,
    [nestId, extraFlowTypeId ?? ""],
  )) as Array<{ from_node: string; to_node: string }>;

  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  const nodes = new Set<string>();
  for (const r of rows) {
    if (r.from_node === r.to_node) {
      throw new ConflictError(
        `cycle: ["${r.from_node}"] — a flow edge cannot be a self-loop`,
      );
    }
    nodes.add(r.from_node);
    nodes.add(r.to_node);
    (adj.get(r.from_node) ?? adj.set(r.from_node, []).get(r.from_node)!).push(
      r.to_node,
    );
    indeg.set(r.to_node, (indeg.get(r.to_node) ?? 0) + 1);
    if (!indeg.has(r.from_node)) indeg.set(r.from_node, indeg.get(r.from_node) ?? 0);
  }

  const queue = [...nodes].filter((n) => (indeg.get(n) ?? 0) === 0);
  let removed = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    removed++;
    for (const nb of adj.get(cur) ?? []) {
      indeg.set(nb, (indeg.get(nb) ?? 0) - 1);
      if ((indeg.get(nb) ?? 0) === 0) queue.push(nb);
    }
  }
  if (removed < nodes.size) {
    throw new ConflictError(
      "cycle: enabling flow on this edge type would create a cycle in the flow graph — flow edges must form a DAG",
    );
  }
}

async function assertNoFlowCycle(
  nestId: string,
  fromNode: string,
  toNode: string,
): Promise<void> {
  if (fromNode === toNode) {
    throw new ConflictError(
      `cycle: ["${fromNode}","${toNode}"] — flow edges must form a DAG`,
    );
  }
  const db = getDb();
  const rows = (await db.all(
    `SELECT e.from_node, e.to_node FROM edges e
       JOIN edge_types t ON t.id = e.type_id
      WHERE e.nest_id = ? AND t.is_flow = 1`,
    [nestId],
  )) as Array<{ from_node: string; to_node: string }>;
  const adj = new Map<string, string[]>();
  for (const r of rows) {
    (adj.get(r.from_node) ?? adj.set(r.from_node, []).get(r.from_node)!).push(
      r.to_node,
    );
  }
  // Path from toNode back to fromNode + the new edge = a cycle.
  const parent = new Map<string, string>();
  const queue = [toNode];
  const seen = new Set([toNode]);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === fromNode) {
      const path = [fromNode];
      let p = fromNode;
      while (p !== toNode) {
        p = parent.get(p)!;
        path.push(p);
      }
      path.reverse().push(fromNode);
      throw new ConflictError(
        `cycle: ${JSON.stringify(path)} — flow edges must form a DAG`,
      );
    }
    for (const nb of adj.get(cur) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb);
        parent.set(nb, cur);
        queue.push(nb);
      }
    }
  }
}

export const edgeRoutes = new Hono<AuthEnv>();
edgeRoutes.use("*", requireWorkflowPlane);

// GET /nests/:nestId/edges?type=<name|id>&node=<id>
edgeRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const db = getDb();
  const typeFilter = c.req.query("type")?.trim();
  const nodeFilter = c.req.query("node")?.trim();

  let sql = `SELECT e.*, t.id as t_id, t.name as t_name, t.color as t_color, t.is_flow as t_is_flow
               FROM edges e JOIN edge_types t ON t.id = e.type_id
              WHERE e.nest_id = ?`;
  const args: unknown[] = [nestId];
  if (typeFilter) {
    sql += " AND (t.id = ? OR LOWER(t.name) = LOWER(?))";
    args.push(typeFilter, typeFilter);
  }
  if (nodeFilter) {
    sql += " AND (e.from_node = ? OR e.to_node = ?)";
    args.push(nodeFilter, nodeFilter);
  }
  sql += " ORDER BY e.created_at";
  const rows = (await db.all(sql, args as any)) as Array<
    EdgeRow & { t_id: string; t_name: string; t_color: string | null; t_is_flow: number }
  >;
  const edges = rows.map((r) =>
    toResponse(r, {
      id: r.t_id,
      name: r.t_name,
      color: r.t_color,
      is_flow: r.t_is_flow,
    } as EdgeTypeRow),
  );
  return c.json({ count: edges.length, edges });
});

// POST /nests/:nestId/edges
edgeRoutes.post("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<Record<string, unknown>>();
  const fromRaw = typeof body.from_node === "string" ? body.from_node.trim() : "";
  const toRaw = typeof body.to_node === "string" ? body.to_node.trim() : "";
  const typeRef = typeof body.type === "string" ? body.type.trim() : "";
  if (!fromRaw || !toRaw || !typeRef) {
    throw new ValidationError("from_node, to_node, and type are required");
  }
  // SECURITY: node ids feed storage.readDocument below — reject traversal so a
  // caller can't probe/reference another nest's files. (src/shared/node-id.ts)
  const fromNode = assertSafeNodeId(fromRaw);
  const toNode = assertSafeNodeId(toRaw);

  const db = getDb();
  const definedBy = await resolveCallerEmail(c.get("userId"));
  await seedDefaultEdgeTypes(nestId, definedBy);

  const type = (await db.get(
    "SELECT * FROM edge_types WHERE nest_id = ? AND (id = ? OR LOWER(name) = LOWER(?))",
    [nestId, typeRef, typeRef],
  )) as EdgeTypeRow | undefined;
  if (!type) {
    throw new ValidationError(
      `unknown edge type "${typeRef}" — define it in the registry first`,
    );
  }

  // Both endpoints must be real documents in this nest.
  const { storage } = await engineCache.get(nestId);
  for (const nodeId of [fromNode, toNode]) {
    try {
      await storage.readDocument(nodeId);
    } catch {
      throw new ValidationError(`node not found: "${nodeId}"`);
    }
  }

  const { mode, stored } = await validateCondition(
    nestId,
    body.condition_mode as string | undefined,
    body.condition,
  );
  if (type.is_flow) {
    await assertNoFlowCycle(nestId, fromNode, toNode);
  }
  const metadata =
    body.metadata === undefined || body.metadata === null
      ? null
      : JSON.stringify(body.metadata);

  const now = new Date().toISOString();
  const id = uuid();
  await db.run(
    `INSERT INTO edges
       (id, nest_id, from_node, to_node, type_id, condition_mode, condition, metadata, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, nestId, fromNode, toNode, type.id, mode, stored, metadata, definedBy, now, now],
  );
  const row = (await db.get("SELECT * FROM edges WHERE id = ?", [id])) as EdgeRow;
  return c.json({ edge: toResponse(row, type) }, 201);
});

// DELETE /nests/:nestId/edges/:id
edgeRoutes.delete("/:id", async (c) => {
  const nestId = c.req.param("nestId")!;
  const id = c.req.param("id")!;
  const db = getDb();
  const row = await db.get(
    "SELECT id FROM edges WHERE id = ? AND nest_id = ?",
    [id, nestId],
  );
  if (!row) throw new NotFoundError("Edge not found");
  await db.run("DELETE FROM edges WHERE id = ?", [id]);
  return c.json({ deleted: true });
});
