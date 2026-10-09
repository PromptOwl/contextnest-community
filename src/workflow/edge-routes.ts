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
import type { Querier } from "../db/adapter.js";
import { engineCache } from "../nodes/engine.js";
import { ValidationError, NotFoundError, ConflictError } from "../shared/errors.js";
import { safeJson } from "../shared/json.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { nodeTrail } from "./flow-graph.js";
import {
  requireWorkflowPlane,
  seedDefaultEdgeTypes,
  assertNotRelationType,
  type EdgeTypeRow,
} from "./edge-type-routes.js";

export interface EdgeRow {
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

export function toResponse(e: EdgeRow, t: EdgeTypeRow) {
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
export async function validateCondition(
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
        // Only tolerate the definitions table being absent (glossary PR not
        // merged yet) — any other DB error is real and must surface.
        if (!/no such table/i.test((err as Error)?.message ?? "")) throw err;
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

/**
 * Reject a new flow edge that would close a cycle; names the path. Takes the
 * query handle (a tx) so the read of existing flow edges and the caller's
 * INSERT run under one BEGIN IMMEDIATE lock — otherwise two concurrent creates
 * that each individually close a cycle could both pass this check.
 */
export async function assertNoFlowCycle(
  db: Querier,
  nestId: string,
  fromNode: string,
  toNode: string,
): Promise<void> {
  if (fromNode === toNode) {
    throw new ConflictError(
      `This step loops back on itself: ${await nodeTrail(db, nestId, [fromNode])}.\n\nA flow can't return to a step it already ran.`,
    );
  }
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
      // path is fromNode..toNode (BFS parent-walk); reverse to toNode..fromNode
      // then close the loop with the new edge fromNode→toNode.
      path.reverse().push(toNode);
      throw new ConflictError(
        `These steps loop back on each other: ${await nodeTrail(db, nestId, path)}.\n\nA flow can't return to a step it already ran.`,
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

/**
 * One edge per (from, to, type): a repeat carries no extra meaning and its wire
 * draws exactly on top of the original, so the canvas shows one line where two
 * exist. Runs inside the caller's tx (same BEGIN IMMEDIATE as the INSERT) so two
 * concurrent creates can't both pass. `excludeId` skips the row being retyped.
 */
export async function assertNoDuplicateEdge(
  db: Querier,
  nestId: string,
  fromNode: string,
  toNode: string,
  type: EdgeTypeRow,
  excludeId?: string,
): Promise<void> {
  // Append the exclusion instead of `(? IS NULL OR id != ?)`: a bare param in
  // `IS NULL` has no inferable type, and Postgres rejects it with 42P18.
  const row = await db.get(
    `SELECT id FROM edges
      WHERE nest_id = ? AND from_node = ? AND to_node = ? AND type_id = ?` +
      (excludeId ? " AND id != ?" : ""),
    excludeId
      ? [nestId, fromNode, toNode, type.id, excludeId]
      : [nestId, fromNode, toNode, type.id],
  );
  if (row) {
    throw new ConflictError(
      `a "${type.name}" connection from "${fromNode}" to "${toNode}" already exists`,
    );
  }
}

export const edgeRoutes = new Hono<AuthEnv>();
// Gate every route on the feature flag PER ROUTE, not via `use("*", …)`: this
// router mounts under `/nests/:nestId/edges`, and a wildcard middleware there
// flattens to `/nests/:nestId/edges/*` — a path with BOTH a `:label` and a `*`,
// which the app's LinearRouter (chosen for multi-segment node ids) rejects with
// UnsupportedPathError, wedging the whole app. Mirrors edge-type-routes.

// GET /nests/:nestId/edges?type=<name|id>&node=<id>
edgeRoutes.get("/", requireWorkflowPlane, async (c) => {
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
edgeRoutes.post("/", requireWorkflowPlane, async (c) => {
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
  const createdBy = await resolveCallerEmail(c.get("userId"));
  // Seed attributes to the nest owner (see edge-type-routes); createdBy is
  // the caller, populating this edge's created_by column below.
  await seedDefaultEdgeTypes(nestId);

  const type = (await db.get(
    "SELECT * FROM edge_types WHERE nest_id = ? AND (id = ? OR LOWER(name) = LOWER(?))",
    [nestId, typeRef, typeRef],
  )) as EdgeTypeRow | undefined;
  if (!type) {
    throw new ValidationError(
      `unknown edge type "${typeRef}" — define it in the registry first`,
    );
  }
  // Task relations carry their own rules (read access to both ends, the
  // blocking-loop guard) — they're written only through the relations API.
  assertNotRelationType(type);

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
  const metadata =
    body.metadata === undefined || body.metadata === null
      ? null
      : JSON.stringify(body.metadata);

  const now = new Date().toISOString();
  const id = uuid();
  // Cycle check + insert under one BEGIN IMMEDIATE lock so concurrent flow
  // creates can't each pass the DAG guard against the pre-request graph and
  // both land, closing a cycle.
  await db.transaction(async (tx) => {
    await assertNoDuplicateEdge(tx, nestId, fromNode, toNode, type);
    if (type.is_flow) {
      await assertNoFlowCycle(tx, nestId, fromNode, toNode);
    }
    await tx.run(
      `INSERT INTO edges
         (id, nest_id, from_node, to_node, type_id, condition_mode, condition, metadata, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, nestId, fromNode, toNode, type.id, mode, stored, metadata, createdBy, now, now],
    );
  });
  const row = (await db.get("SELECT * FROM edges WHERE id = ?", [id])) as EdgeRow;
  return c.json({ edge: toResponse(row, type) }, 201);
});

// PATCH /nests/:nestId/edges/:id — retype/recondition an existing edge (the
// canvas config panel). Endpoints (from/to) are immutable: rewiring is
// delete + create, which keeps the cycle check story simple.
edgeRoutes.patch("/:id", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  const id = c.req.param("id")!;
  const body = await c.req.json<Record<string, unknown>>();

  const db = getDb();
  const row = (await db.get(
    "SELECT * FROM edges WHERE id = ? AND nest_id = ?",
    [id, nestId],
  )) as EdgeRow | undefined;
  if (!row) throw new NotFoundError("Edge not found");

  let type = (await db.get(
    "SELECT * FROM edge_types WHERE id = ?",
    [row.type_id],
  )) as EdgeTypeRow;
  // Retyping into or out of a task relation would skip the relation rules.
  assertNotRelationType(type);
  const wasFlow = !!type.is_flow;
  let retype: EdgeTypeRow | null = null;
  if (typeof body.type === "string" && body.type.trim()) {
    const next = (await db.get(
      "SELECT * FROM edge_types WHERE nest_id = ? AND (id = ? OR LOWER(name) = LOWER(?))",
      [nestId, body.type.trim(), body.type.trim()],
    )) as EdgeTypeRow | undefined;
    if (!next) {
      throw new ValidationError(
        `unknown edge type "${body.type}" — define it in the registry first`,
      );
    }
    assertNotRelationType(next);
    // Checked below, inside the tx that carries the UPDATE — two concurrent
    // retypes onto the same (from, to, type) would otherwise both pass against
    // the pre-request graph and land the duplicate this guard exists to stop.
    if (next.id !== type.id) retype = next;
    type = next;
  }

  let mode = row.condition_mode;
  let stored = row.condition;
  if (body.condition_mode !== undefined || body.condition !== undefined) {
    const v = await validateCondition(
      nestId,
      (body.condition_mode ?? row.condition_mode) as string | undefined,
      body.condition !== undefined ? body.condition : row.condition,
    );
    mode = v.mode as EdgeRow["condition_mode"];
    stored = v.stored;
  }

  await db.transaction(async (tx) => {
    if (retype) {
      await assertNoDuplicateEdge(tx, nestId, row.from_node, row.to_node, retype, id);
      // Becoming a flow edge can close a cycle the old type couldn't.
      if (retype.is_flow && !wasFlow) {
        await assertNoFlowCycle(tx, nestId, row.from_node, row.to_node);
      }
    }
    await tx.run(
      `UPDATE edges SET type_id = ?, condition_mode = ?, condition = ?, updated_at = ?
        WHERE id = ?`,
      [type.id, mode, stored, new Date().toISOString(), id],
    );
  });
  const updated = (await db.get("SELECT * FROM edges WHERE id = ?", [id])) as EdgeRow;
  return c.json({ edge: toResponse(updated, type) });
});

// DELETE /nests/:nestId/edges/:id
edgeRoutes.delete("/:id", requireWorkflowPlane, async (c) => {
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
