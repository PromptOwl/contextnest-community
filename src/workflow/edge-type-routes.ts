/**
 * Edge-type registry — the vocabulary of connections ("turing" track).
 * The definitions-table move applied to relations: stewards articulate once
 * what `escalates-when` or `derives-from` MEANS in this nest; edges then
 * reference the registry. GET is read-tier, mutations write-tier via the
 * standard nest middleware.
 *
 * Everything here is feature-flagged: requireWorkflowPlane 404s when
 * FEATURE_WORKFLOW_PLANE is off, so an un-flagged server exposes nothing
 * (and this check is the future license-tier hook).
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import type { AuthEnv } from "../auth/middleware.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { assertFlowGraphAcyclic } from "./flow-graph.js";

export const requireWorkflowPlane = async (c: any, next: any) => {
  if (!config.FEATURE_WORKFLOW_PLANE) {
    return c.json(
      {
        error:
          "The workflow plane is not enabled on this server. An admin can turn it on with FEATURE_WORKFLOW_PLANE=true.",
      },
      404,
    );
  }
  return next();
};

export interface EdgeTypeRow {
  id: string;
  nest_id: string;
  name: string;
  description: string;
  direction: "directed" | "undirected";
  is_flow: number;
  condition_schema: string | null;
  color: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Seed the five stock flow types once per nest (idempotent, lazy). */
export async function seedDefaultEdgeTypes(
  nestId: string,
  createdBy: string,
): Promise<void> {
  const db = getDb();
  const existing = (await db.get(
    "SELECT COUNT(*) as c FROM edge_types WHERE nest_id = ?",
    [nestId],
  )) as { c: number };
  if (existing.c > 0) return;
  const now = new Date().toISOString();
  const defaults: Array<[string, string, number, string]> = [
    ["next", "Unconditional flow: after the source completes, run the target.", 1, "#16a34a"],
    ["on-success", "Follow only when the source step succeeded.", 1, "#16a34a"],
    ["on-failure", "Follow only when the source step failed.", 1, "#ef4444"],
    ["depends-on", "The source requires the target (ordering/lineage; not conditional flow).", 0, "#3b82f6"],
    ["owned-by", "Ownership: the target person/team is accountable for the source node.", 0, "#64748b"],
  ];
  for (const [name, description, isFlow, color] of defaults) {
    await db.run(
      `INSERT INTO edge_types
         (id, nest_id, name, description, direction, is_flow, condition_schema, color, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'directed', ?, NULL, ?, ?, ?, ?)`,
      [uuid(), nestId, name, description, isFlow, color, createdBy, now, now],
    );
  }
}

function parseConditionSchema(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const obj = typeof raw === "string" ? safeJson(raw) : raw;
  if (
    !obj ||
    typeof obj !== "object" ||
    !Array.isArray((obj as any).params) ||
    !(obj as any).params.every((p: unknown) => typeof p === "string")
  ) {
    throw new ValidationError(
      'condition_schema must be {"params": [string…], "mode_default"?: "structured"|"nl"|"open"}',
    );
  }
  const mode = (obj as any).mode_default;
  if (mode !== undefined && !["structured", "nl", "open"].includes(mode)) {
    throw new ValidationError(
      "condition_schema.mode_default must be structured | nl | open",
    );
  }
  return JSON.stringify({ params: (obj as any).params, mode_default: mode ?? "structured" });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const toResponse = (r: EdgeTypeRow) => ({
  ...r,
  is_flow: !!r.is_flow,
  condition_schema: r.condition_schema ? safeJson(r.condition_schema) : null,
});

export const edgeTypeRoutes = new Hono<AuthEnv>();
edgeTypeRoutes.use("*", requireWorkflowPlane);

// GET /nests/:nestId/edge-types
edgeTypeRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  await seedDefaultEdgeTypes(nestId, await resolveCallerEmail(c.get("userId")));
  const rows = (await getDb().all(
    "SELECT * FROM edge_types WHERE nest_id = ? ORDER BY LOWER(name)",
    [nestId],
  )) as EdgeTypeRow[];
  return c.json({ count: rows.length, edge_types: rows.map(toResponse) });
});

// POST /nests/:nestId/edge-types — upsert by name (case-insensitive), the
// definitions pattern: one articulation per relation, no duplicates.
edgeTypeRoutes.post("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.name !== "string" || !body.name.trim()) {
    throw new ValidationError("name is required");
  }
  if (typeof body.description !== "string" || !body.description.trim()) {
    throw new ValidationError("description (the articulation) is required");
  }
  const name = body.name.trim();
  if (name.length > 100 || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    throw new ValidationError(
      "name must be alphanumeric-with-dashes, 100 chars max (e.g. escalates-when)",
    );
  }
  const direction = String(body.direction ?? "directed");
  if (!["directed", "undirected"].includes(direction)) {
    throw new ValidationError("direction must be directed | undirected");
  }
  const conditionSchema = parseConditionSchema(body.condition_schema);
  const isFlow = body.is_flow === true ? 1 : 0;
  const color =
    typeof body.color === "string" && /^#[0-9a-f]{6}$/i.test(body.color)
      ? body.color
      : null;

  const db = getDb();
  const definedBy = await resolveCallerEmail(c.get("userId"));
  const now = new Date().toISOString();
  await seedDefaultEdgeTypes(nestId, definedBy);

  let created = false;
  await db.transaction(async (tx) => {
    const existing = (await tx.get(
      "SELECT id, is_flow FROM edge_types WHERE nest_id = ? AND LOWER(name) = LOWER(?)",
      [nestId, name],
    )) as { id: string; is_flow: number } | undefined;
    // Flipping an existing non-flow type to flow can turn edges that never
    // passed the per-edge cycle guard into a cyclic flow graph. Re-validate
    // the whole would-be flow graph before persisting the flip.
    if (existing && !existing.is_flow && isFlow) {
      await assertFlowGraphAcyclic(nestId, existing.id);
    }
    if (existing) {
      await tx.run(
        `UPDATE edge_types SET name = ?, description = ?, direction = ?, is_flow = ?,
           condition_schema = ?, color = ?, updated_at = ? WHERE id = ?`,
        [name, (body.description as string).trim(), direction, isFlow, conditionSchema, color, now, existing.id],
      );
    } else {
      created = true;
      await tx.run(
        `INSERT INTO edge_types
           (id, nest_id, name, description, direction, is_flow, condition_schema, color, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), nestId, name, (body.description as string).trim(), direction, isFlow, conditionSchema, color, definedBy, now, now],
      );
    }
  });
  const row = (await db.get(
    "SELECT * FROM edge_types WHERE nest_id = ? AND LOWER(name) = LOWER(?)",
    [nestId, name],
  )) as EdgeTypeRow;
  return c.json({ edge_type: toResponse(row) }, created ? 201 : 200);
});

// DELETE /nests/:nestId/edge-types/:id — refuses while edges reference it,
// so a type can't be yanked out from under the graph.
edgeTypeRoutes.delete("/:id", async (c) => {
  const nestId = c.req.param("nestId")!;
  const id = c.req.param("id")!;
  const db = getDb();
  const row = await db.get(
    "SELECT id FROM edge_types WHERE id = ? AND nest_id = ?",
    [id, nestId],
  );
  if (!row) throw new NotFoundError("Edge type not found");
  const inUse = (await db.get(
    "SELECT COUNT(*) as c FROM edges WHERE type_id = ?",
    [id],
  )) as { c: number };
  if (inUse.c > 0) {
    throw new ValidationError(
      `Edge type is in use by ${inUse.c} edge${inUse.c === 1 ? "" : "s"} — delete those first.`,
    );
  }
  await db.run("DELETE FROM edge_types WHERE id = ?", [id]);
  return c.json({ deleted: true });
});
