/**
 * Task relations — blocks / blocked by / relates to / duplicates — stored as
 * typed edges in the workflow plane's `edges` table.
 *
 * WHY NOT BEHIND FEATURE_WORKFLOW_PLANE. Relations are core task UX (Linear,
 * Jira and ClickUp all ship them on every plan), so they work with the flag
 * off. What stays gated is the plane itself — the edge-type registry routes,
 * the generic /edges routes, runs, schedules and the canvas. The tables were
 * always created unconditionally (migration 016 ships the schema so flipping
 * the flag needs no migration), so reusing them needs no migration either.
 *
 * RESERVED TYPES. Relations use three built-in edge types whose names carry a
 * `task:` prefix. The registry's own name rule (alphanumeric-with-dashes)
 * can't produce a colon, so a steward-defined type can never collide with,
 * shadow or retype one of these. They are created lazily per nest, are never
 * flow types (so the run engine and the DAG guard ignore them), and are kept
 * out of the registry listing and the generic edge create/retype paths — the
 * only way to write one is this module, which carries the relation rules
 * (same nest, no self-edge, no blocking loop, read access to both ends).
 *
 * DIRECTION. `blocked_by` and `duplicated_by` are VIEWS, not stored edges:
 * "B is blocked by A" is the one `A —task:blocks→ B` row read from B's side.
 * `relates_to` is symmetric and stored once.
 *
 * PERMISSIONS. Callers gate the write (REST: the nest middleware's write tier;
 * MCP: canUserEdit on the task). This module enforces what both share: the
 * caller must be able to READ the task and the other end, and a related node
 * the caller can't read is never named — it is counted in `hidden` instead.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import type { Querier } from "../db/adapter.js";
import { ConflictError, NotFoundError, ValidationError } from "../shared/errors.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { canReadNode, filterAccessible } from "../governance/access-guard.js";
import { nestDoneTags } from "../nests/service.js";
import { ensureNodeIndex } from "./node-index.js";

/** What a caller can ask for. The `_by` kinds are the inverse views. */
export const RELATION_KINDS = [
  "blocks",
  "blocked_by",
  "relates_to",
  "duplicates",
  "duplicated_by",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/** Prefix no registry-defined edge type can carry (the name rule forbids `:`). */
export const RELATION_TYPE_PREFIX = "task:";

interface StoredType {
  name: string;
  description: string;
  direction: "directed" | "undirected";
  color: string;
}

const STORED: Record<"blocks" | "relates_to" | "duplicates", StoredType> = {
  blocks: {
    name: "task:blocks",
    description: "Task relation: the source must be done before the target can move.",
    direction: "directed",
    color: "#dc2626",
  },
  relates_to: {
    name: "task:relates-to",
    description: "Task relation: the two tasks are related (symmetric).",
    direction: "undirected",
    color: "#64748b",
  },
  duplicates: {
    name: "task:duplicates",
    description: "Task relation: the source duplicates the target.",
    direction: "directed",
    color: "#a16207",
  },
};

/** True for the reserved relation edge types (by name). */
export function isRelationTypeName(name: string | null | undefined): boolean {
  return typeof name === "string" && name.toLowerCase().startsWith(RELATION_TYPE_PREFIX);
}

/** Accepts the kinds above plus their dashed / spaced spellings. */
export function parseRelationKind(raw: unknown): RelationKind {
  const k = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if ((RELATION_KINDS as readonly string[]).includes(k)) return k as RelationKind;
  throw new ValidationError(
    `type must be one of ${RELATION_KINDS.join(", ")}, got "${raw ?? ""}"`,
  );
}

/** A caller-facing kind → the stored edge (direction normalized). */
function toStored(
  kind: RelationKind,
  taskId: string,
  otherId: string,
): { type: StoredType; from: string; to: string } {
  switch (kind) {
    case "blocks":
      return { type: STORED.blocks, from: taskId, to: otherId };
    case "blocked_by":
      return { type: STORED.blocks, from: otherId, to: taskId };
    case "duplicates":
      return { type: STORED.duplicates, from: taskId, to: otherId };
    case "duplicated_by":
      return { type: STORED.duplicates, from: otherId, to: taskId };
    case "relates_to":
      return { type: STORED.relates_to, from: taskId, to: otherId };
  }
}

/** A stored edge seen from `taskId` → the kind and the other end. */
function viewFrom(
  typeName: string,
  from: string,
  to: string,
  taskId: string,
): { kind: RelationKind; other: string } | null {
  const outgoing = from === taskId;
  const other = outgoing ? to : from;
  switch (typeName.toLowerCase()) {
    case STORED.blocks.name:
      return { kind: outgoing ? "blocks" : "blocked_by", other };
    case STORED.duplicates.name:
      return { kind: outgoing ? "duplicates" : "duplicated_by", other };
    case STORED.relates_to.name:
      return { kind: "relates_to", other };
    default:
      return null;
  }
}

/** Create the reserved type for this nest if it isn't there yet; return its id. */
async function ensureRelationType(
  db: Querier,
  nestId: string,
  t: StoredType,
  createdBy: string,
): Promise<string> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO edge_types
       (id, nest_id, name, description, direction, is_flow, condition_schema, color, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [uuid(), nestId, t.name, t.description, t.direction, t.color, createdBy, now, now],
  );
  const row = (await db.get(
    "SELECT id FROM edge_types WHERE nest_id = ? AND LOWER(name) = LOWER(?)",
    [nestId, t.name],
  )) as { id: string } | undefined;
  if (!row) throw new Error(`relation type ${t.name} missing after insert`);
  return row.id;
}

interface IndexedMeta {
  title: string;
  type: string;
  done: boolean;
}

/**
 * Title, type and done-ness for a set of node ids, from the node_index mirror
 * (no vault reads). A node is done when it carries `completed_at` (stamped when
 * a task enters a done column) or one of the nest's done tags — the second
 * covers non-task documents, which the board never stamps.
 */
async function indexedMeta(
  nestId: string,
  ids: string[],
): Promise<Map<string, IndexedMeta>> {
  const out = new Map<string, IndexedMeta>();
  if (ids.length === 0) return out;
  await ensureNodeIndex(nestId);
  const done = new Set(await nestDoneTags(nestId));
  const unique = [...new Set(ids)];
  // Chunked: SQLite caps bound parameters per statement.
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = (await getDb().all(
      `SELECT node_id, frontmatter_json FROM node_index
        WHERE nest_id = ? AND node_id IN (${chunk.map(() => "?").join(",")})`,
      [nestId, ...chunk],
    )) as Array<{ node_id: string; frontmatter_json: string }>;
    for (const r of rows) {
      let fm: any = {};
      try {
        fm = JSON.parse(r.frontmatter_json) ?? {};
      } catch {
        /* unparseable row: treat as untitled, open */
      }
      const tags: string[] = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
      const completed = !!fm.metadata?.completed_at;
      const tagDone = tags.some((t) => done.has(t.toLowerCase().replace(/^#/, "")));
      out.set(r.node_id, {
        title: fm.title != null ? String(fm.title) : r.node_id,
        type: fm.type || "document",
        done: completed || tagDone,
      });
    }
  }
  return out;
}

/**
 * Open blockers per blocked node: how many `blocks` edges point at it from a
 * node that isn't done. Counts blockers the caller may not be able to read —
 * the count reveals nothing but "something open blocks this", which is the
 * same thing the relations panel's "1 hidden" says. Pass `only` to restrict
 * to the nodes being rendered.
 */
export async function openBlockerCounts(
  nestId: string,
  only?: Iterable<string>,
): Promise<Map<string, number>> {
  const rows = (await getDb().all(
    `SELECT e.from_node, e.to_node FROM edges e
       JOIN edge_types t ON t.id = e.type_id
      WHERE e.nest_id = ? AND LOWER(t.name) = ?`,
    [nestId, STORED.blocks.name],
  )) as Array<{ from_node: string; to_node: string }>;
  const out = new Map<string, number>();
  if (rows.length === 0) return out;
  const wanted = only ? new Set(only) : null;
  const relevant = wanted ? rows.filter((r) => wanted.has(r.to_node)) : rows;
  if (relevant.length === 0) return out;
  const meta = await indexedMeta(
    nestId,
    relevant.map((r) => r.from_node),
  );
  for (const r of relevant) {
    const m = meta.get(r.from_node);
    // Missing from the index = gone (a delete purges its edges; this is the
    // window before that lands) — not something to wait on.
    if (!m || m.done) continue;
    out.set(r.to_node, (out.get(r.to_node) ?? 0) + 1);
  }
  return out;
}

export interface RelationView {
  id: string;
  type: RelationKind;
  node: { id: string; title: string; type: string; done: boolean };
  created_by: string;
  created_at: string;
}

export interface RelationsResult {
  node_id: string;
  relations: RelationView[];
  /** Related nodes the caller can't read, per kind. Never named. */
  hidden: Partial<Record<RelationKind, number>>;
  hidden_count: number;
  /** Blockers that aren't done yet, readable or not. */
  open_blockers: number;
  blocked: boolean;
}

export interface RelationCaller {
  nestId: string;
  userId: string;
  userEmail: string;
}

/**
 * Can the caller read this node? Through filterAccessible rather than
 * canReadNode: the listing gate also narrows a share-grant-only caller to the
 * documents their grants cover, where canReadNode (which trusts the route
 * middleware to have done that) answers "open read" on an ungoverned nest.
 */
export async function callerCanRead(
  caller: RelationCaller,
  nodeId: string,
): Promise<boolean> {
  if (!(await canReadNode(caller.nestId, nodeId, caller.userId, caller.userEmail))) {
    return false;
  }
  const visible = await filterAccessible(caller.nestId, caller.userId, caller.userEmail, [
    { id: nodeId },
  ]);
  return visible.length === 1;
}

/** The task must exist and be readable; a miss and a denial look the same. */
async function assertReadableNode(
  caller: RelationCaller,
  nodeId: string,
): Promise<void> {
  const meta = await indexedMeta(caller.nestId, [nodeId]);
  if (!meta.has(nodeId) || !(await callerCanRead(caller, nodeId))) {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }
}

/** Every relation on a node, as the caller may see it. */
export async function listRelations(
  caller: RelationCaller,
  rawNodeId: string,
): Promise<RelationsResult> {
  const nodeId = assertSafeNodeId(rawNodeId);
  await assertReadableNode(caller, nodeId);
  const rows = (await getDb().all(
    `SELECT e.id, e.from_node, e.to_node, e.created_by, e.created_at, t.name AS type_name
       FROM edges e JOIN edge_types t ON t.id = e.type_id
      WHERE e.nest_id = ? AND LOWER(t.name) LIKE ?
        AND (e.from_node = ? OR e.to_node = ?)
      ORDER BY e.created_at`,
    [caller.nestId, `${RELATION_TYPE_PREFIX}%`, nodeId, nodeId],
  )) as Array<{
    id: string;
    from_node: string;
    to_node: string;
    created_by: string;
    created_at: string;
    type_name: string;
  }>;
  const views = rows
    .map((r) => ({ row: r, view: viewFrom(r.type_name, r.from_node, r.to_node, nodeId) }))
    .filter((x): x is { row: (typeof rows)[number]; view: { kind: RelationKind; other: string } } => !!x.view);

  const others = [...new Set(views.map((v) => v.view.other))];
  const readable = new Set(
    (
      await filterAccessible(
        caller.nestId,
        caller.userId,
        caller.userEmail,
        others.map((id) => ({ id })),
      )
    ).map((n) => n.id),
  );
  const meta = await indexedMeta(caller.nestId, others);

  const relations: RelationView[] = [];
  const hidden: Partial<Record<RelationKind, number>> = {};
  let hiddenCount = 0;
  let openBlockers = 0;
  for (const { row, view } of views) {
    const m = meta.get(view.other);
    if (!m) continue; // the other end is gone; its purge drops this row
    if (view.kind === "blocked_by" && !m.done) openBlockers++;
    if (!readable.has(view.other)) {
      hidden[view.kind] = (hidden[view.kind] ?? 0) + 1;
      hiddenCount++;
      continue;
    }
    relations.push({
      id: row.id,
      type: view.kind,
      node: { id: view.other, title: m.title, type: m.type, done: m.done },
      created_by: row.created_by,
      created_at: row.created_at,
    });
  }
  return {
    node_id: nodeId,
    relations,
    hidden,
    hidden_count: hiddenCount,
    open_blockers: openBlockers,
    blocked: openBlockers > 0,
  };
}

/**
 * False when `from —blocks→ to` would close a loop. BFS forward from `to` over the
 * existing blocks edges; reaching `from` means `to` already (transitively)
 * blocks `from`. Runs on the caller's tx so the read and the INSERT share one
 * write lock — two concurrent adds can't each pass against the old graph.
 */
async function blockingLoopFree(
  db: Querier,
  nestId: string,
  typeId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const rows = (await db.all(
    "SELECT from_node, to_node FROM edges WHERE nest_id = ? AND type_id = ?",
    [nestId, typeId],
  )) as Array<{ from_node: string; to_node: string }>;
  const adj = new Map<string, string[]>();
  for (const r of rows) {
    const list = adj.get(r.from_node) ?? [];
    list.push(r.to_node);
    adj.set(r.from_node, list);
  }
  const seen = new Set([to]);
  const queue = [to];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === from) return false;
    for (const nb of adj.get(cur) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  return true;
}

/** Add a relation from `taskId`'s point of view. Returns the fresh listing. */
export async function addRelation(
  caller: RelationCaller,
  rawTaskId: string,
  rawKind: unknown,
  rawOtherId: unknown,
): Promise<{ relation: RelationView; relations: RelationsResult }> {
  const taskId = assertSafeNodeId(rawTaskId);
  const kind = parseRelationKind(rawKind);
  const otherRaw = typeof rawOtherId === "string" ? rawOtherId.trim() : "";
  if (!otherRaw) throw new ValidationError("node (the other task's id) is required");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(otherRaw)) {
    // contextnest://other-nest/... — edges carry one nest_id and both ends
    // resolve inside it, so a cross-nest relation has nowhere to live.
    throw new ValidationError("Relations link tasks in the same nest; cross-nest relations aren't supported.");
  }
  const otherId = assertSafeNodeId(otherRaw);
  if (otherId === taskId) {
    throw new ValidationError("A task can't be related to itself.");
  }
  await assertReadableNode(caller, taskId);
  // The other end must exist in THIS nest and be readable — a node the caller
  // can't see answers exactly like one that doesn't exist.
  await assertReadableNode(caller, otherId);

  const { type, from, to } = toStored(kind, taskId, otherId);
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    const typeId = await ensureRelationType(tx, caller.nestId, type, caller.userEmail);
    const dup = (await tx.get(
      type.direction === "undirected"
        ? `SELECT id FROM edges WHERE nest_id = ? AND type_id = ?
             AND ((from_node = ? AND to_node = ?) OR (from_node = ? AND to_node = ?))`
        : `SELECT id FROM edges WHERE nest_id = ? AND type_id = ?
             AND from_node = ? AND to_node = ?`,
      type.direction === "undirected"
        ? [caller.nestId, typeId, from, to, to, from]
        : [caller.nestId, typeId, from, to],
    )) as { id: string } | undefined;
    if (dup) throw new ConflictError("Those two are already related that way.");
    if (type === STORED.blocks) {
      if (!(await blockingLoopFree(tx, caller.nestId, typeId, from, to))) {
        const titles = await indexedMeta(caller.nestId, [from, to]);
        const t = (n: string) => `"${titles.get(n)?.title ?? n}"`;
        throw new ConflictError(
          `${t(to)} already blocks ${t(from)} (directly or through other tasks), so ${t(from)} can't also block ${t(to)} — that would be a loop nothing could finish.`,
        );
      }
    }
    await tx.run(
      `INSERT INTO edges
         (id, nest_id, from_node, to_node, type_id, condition_mode, condition, metadata, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      [id, caller.nestId, from, to, typeId, caller.userEmail, now, now],
    );
  });
  const relations = await listRelations(caller, taskId);
  const relation = relations.relations.find((r) => r.id === id)!;
  return { relation, relations };
}

/** Remove a relation that touches `taskId`. */
export async function removeRelation(
  caller: RelationCaller,
  rawTaskId: string,
  relationId: unknown,
): Promise<RelationsResult> {
  const taskId = assertSafeNodeId(rawTaskId);
  await assertReadableNode(caller, taskId);
  const rid = typeof relationId === "string" ? relationId.trim() : "";
  if (!rid) throw new ValidationError("relation id is required");
  const db = getDb();
  await db.transaction(async (tx) => {
    const row = (await tx.get(
      `SELECT e.id, e.from_node, e.to_node FROM edges e
         JOIN edge_types t ON t.id = e.type_id
        WHERE e.id = ? AND e.nest_id = ? AND LOWER(t.name) LIKE ?`,
      [rid, caller.nestId, `${RELATION_TYPE_PREFIX}%`],
    )) as { id: string; from_node: string; to_node: string } | undefined;
    if (!row || (row.from_node !== taskId && row.to_node !== taskId)) {
      throw new NotFoundError("Relation not found on this task");
    }
    await tx.run("DELETE FROM edges WHERE id = ?", [rid]);
  });
  return listRelations(caller, taskId);
}

/** Prose for agents (context_get, context_relations). */
export function relationsProse(r: RelationsResult): string {
  const label: Record<RelationKind, string> = {
    blocks: "Blocks",
    blocked_by: "Blocked by",
    relates_to: "Relates to",
    duplicates: "Duplicates",
    duplicated_by: "Duplicated by",
  };
  const lines: string[] = [];
  for (const kind of RELATION_KINDS) {
    const items = r.relations.filter((x) => x.type === kind);
    const hidden = r.hidden[kind] ?? 0;
    if (!items.length && !hidden) continue;
    const parts = items.map(
      (x) => `${x.node.title} (${x.node.id}${x.node.done ? ", done" : ""}) [relation ${x.id}]`,
    );
    if (hidden) parts.push(`${hidden} hidden`);
    lines.push(`- ${label[kind]}: ${parts.join("; ")}`);
  }
  if (!lines.length) return "No relations.";
  const head = r.blocked
    ? `Blocked: ${r.open_blockers} open blocker${r.open_blockers === 1 ? "" : "s"}.`
    : "Not blocked.";
  return `${head}\n${lines.join("\n")}`;
}
