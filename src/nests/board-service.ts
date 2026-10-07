/**
 * Saved Board views (CU-wdqcq03xn2) — several named boards per nest, shared
 * with everyone who can see the nest unless marked private to their creator.
 *
 * A board is a VIEW over the nest's nodes, never a copy: it stores how to
 * slice them (dimension, columns, filter) and the per-column card order
 * (rank). Rank lives here and not on the nodes because reordering a column is
 * not an edit of any document — it must not seal versions — and because two
 * boards over the same tasks may order them differently.
 *
 * The config blob is the UI's (ui/src/lib/board-dimensions.ts BoardSettings
 * plus `ranks`), so the server validates shape and size rather than meaning.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { NestPermission } from "../shared/access.js";
import type { SqlParam } from "../db/adapter.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";

export interface BoardConfig {
  dimension: "folder" | "status" | "tag";
  tagNamespace?: string;
  layouts?: Record<string, { columnOrder?: string[]; hiddenColumns?: string[] }>;
  tasksOnly?: boolean;
  /** Only cards carrying every one of these tags (bare, no "#"). */
  filterTags?: string[];
  /** `${layoutKey}::${columnKey}` → node ids, top to bottom. */
  ranks?: Record<string, string[]>;
}

export interface Board {
  id: string;
  nest_id: string;
  name: string;
  private: boolean;
  position: number;
  created_by: string;
  created_by_email: string | null;
  config: BoardConfig;
  created_at: string;
  updated_at: string;
}

const MAX_NAME = 80;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_LIST = 2000;
const MAX_KEYS = 500;
const MAX_BOARDS_PER_NEST = 100;

function now(): string {
  // Same "YYYY-MM-DD HH:MM:SS" UTC shape as the SQL defaults.
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function cleanName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ValidationError("board name is required");
  }
  const name = raw.trim();
  if (name.length > MAX_NAME) {
    throw new ValidationError(`board name must be at most ${MAX_NAME} characters`);
  }
  return name;
}

const strList = (v: unknown, what: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ValidationError(`${what} must be a list of strings`);
  }
  if (v.length > MAX_LIST) throw new ValidationError(`${what} is too long`);
  return [...new Set(v as string[])];
};

/** Shape-check a config from a client. Unknown keys are dropped. */
export function cleanConfig(raw: unknown): BoardConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("config must be an object");
  }
  const r = raw as Record<string, unknown>;
  const dimension = r.dimension ?? "folder";
  if (dimension !== "folder" && dimension !== "status" && dimension !== "tag") {
    throw new ValidationError("config.dimension must be folder, status or tag");
  }
  const out: BoardConfig = { dimension };
  if (r.tagNamespace !== undefined) {
    if (typeof r.tagNamespace !== "string") {
      throw new ValidationError("config.tagNamespace must be a string");
    }
    out.tagNamespace = r.tagNamespace.slice(0, 100);
  }
  if (r.tasksOnly !== undefined) out.tasksOnly = r.tasksOnly === true;
  const filterTags = strList(r.filterTags, "config.filterTags");
  if (filterTags) out.filterTags = filterTags.map((t) => t.replace(/^#/, "")).filter(Boolean);
  const objOfLists = (v: unknown, what: string) => {
    if (v === undefined) return undefined;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new ValidationError(`${what} must be an object`);
    }
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > MAX_KEYS) throw new ValidationError(`${what} has too many entries`);
    return entries;
  };
  const layouts = objOfLists(r.layouts, "config.layouts");
  if (layouts) {
    out.layouts = {};
    for (const [k, v] of layouts) {
      const l = (v ?? {}) as Record<string, unknown>;
      out.layouts[k] = {
        ...(l.columnOrder !== undefined
          ? { columnOrder: strList(l.columnOrder, "columnOrder") }
          : {}),
        ...(l.hiddenColumns !== undefined
          ? { hiddenColumns: strList(l.hiddenColumns, "hiddenColumns") }
          : {}),
      };
    }
  }
  const ranks = objOfLists(r.ranks, "config.ranks");
  if (ranks) {
    out.ranks = {};
    for (const [k, v] of ranks) out.ranks[k] = strList(v, "rank") ?? [];
  }
  if (JSON.stringify(out).length > MAX_CONFIG_BYTES) {
    throw new ValidationError("board config is too large");
  }
  return out;
}

interface Row {
  id: string;
  nest_id: string;
  name: string;
  private: number;
  position: number;
  created_by: string;
  created_by_email?: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}

function toBoard(r: Row): Board {
  let config: BoardConfig = { dimension: "folder" };
  try {
    config = JSON.parse(r.config_json) as BoardConfig;
  } catch {
    // A corrupt blob shows as a fresh board rather than failing the list.
  }
  return {
    id: r.id,
    nest_id: r.nest_id,
    name: r.name,
    private: !!r.private,
    position: Number(r.position),
    created_by: r.created_by,
    created_by_email: r.created_by_email ?? null,
    config,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const SELECT = `SELECT b.*, u.email AS created_by_email
  FROM boards b LEFT JOIN users u ON u.id = b.created_by`;

/** Boards the caller can see: every shared one, plus their own private ones. */
export async function listBoards(nestId: string, userId: string): Promise<Board[]> {
  const rows = (await getDb().all(
    `${SELECT} WHERE b.nest_id = ? AND (b.private = 0 OR b.created_by = ?)
      ORDER BY b.position, b.created_at`,
    [nestId, userId],
  )) as Row[];
  return rows.map(toBoard);
}

async function getVisible(nestId: string, boardId: string, userId: string): Promise<Board> {
  const row = (await getDb().get(`${SELECT} WHERE b.id = ? AND b.nest_id = ?`, [
    boardId,
    nestId,
  ])) as Row | undefined;
  // A private board someone else owns is indistinguishable from a missing one.
  if (!row || (row.private && row.created_by !== userId)) {
    throw new NotFoundError("Board not found");
  }
  return toBoard(row);
}

export async function createBoard(
  nestId: string,
  userId: string,
  input: { name?: unknown; private?: unknown; config?: unknown },
): Promise<Board> {
  const name = cleanName(input.name);
  const config = cleanConfig(input.config ?? { dimension: "tag" });
  const db = getDb();
  const count = (await db.get("SELECT COUNT(*) AS n FROM boards WHERE nest_id = ?", [
    nestId,
  ])) as { n: number | string };
  if (Number(count.n) >= MAX_BOARDS_PER_NEST) {
    throw new ValidationError(`a nest can have at most ${MAX_BOARDS_PER_NEST} boards`);
  }
  const max = (await db.get(
    "SELECT COALESCE(MAX(position), -1) AS p FROM boards WHERE nest_id = ?",
    [nestId],
  )) as { p: number | string };
  const id = randomUUID();
  const ts = now();
  await db.run(
    `INSERT INTO boards (id, nest_id, name, created_by, private, position, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, nestId, name, userId, input.private === true ? 1 : 0, Number(max.p) + 1, JSON.stringify(config), ts, ts],
  );
  return getVisible(nestId, id, userId);
}

export async function updateBoard(
  nestId: string,
  boardId: string,
  userId: string,
  patch: { name?: unknown; private?: unknown; config?: unknown; position?: unknown },
): Promise<Board> {
  const board = await getVisible(nestId, boardId, userId);
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(cleanName(patch.name));
  }
  if (patch.private !== undefined) {
    // Hiding a shared board from the team is the creator's call alone.
    if (board.created_by !== userId) {
      throw new ForbiddenError("Only the board's creator can change who sees it");
    }
    sets.push("private = ?");
    params.push(patch.private === true ? 1 : 0);
  }
  if (patch.config !== undefined) {
    const next = cleanConfig(patch.config);
    // Ranks are written by rankColumn; a config save that omits them (the
    // usual layout change) must not wipe them.
    if (next.ranks === undefined && board.config.ranks) next.ranks = board.config.ranks;
    sets.push("config_json = ?");
    params.push(JSON.stringify(next));
  }
  if (patch.position !== undefined) {
    if (typeof patch.position !== "number" || !Number.isInteger(patch.position)) {
      throw new ValidationError("position must be an integer");
    }
    sets.push("position = ?");
    params.push(patch.position);
  }
  if (sets.length === 0) return board;
  sets.push("updated_at = ?");
  params.push(now());
  await getDb().run(`UPDATE boards SET ${sets.join(", ")} WHERE id = ?`, [...params, boardId]);
  return getVisible(nestId, boardId, userId);
}

/**
 * Set one column's card order. Read-modify-write in a transaction, touching
 * only that column's entry — two people reordering different columns at once
 * both land, which a whole-config PUT would not give.
 */
export async function rankColumn(
  nestId: string,
  boardId: string,
  userId: string,
  input: { key?: unknown; order?: unknown },
): Promise<Board> {
  if (typeof input.key !== "string" || !input.key || input.key.length > 600) {
    throw new ValidationError("key must be a non-empty string");
  }
  const key = input.key;
  const order = strList(input.order, "order");
  if (!order) throw new ValidationError("order is required");
  await getVisible(nestId, boardId, userId);
  const db = getDb();
  await db.transaction(async (tx) => {
    // Row-locked on Postgres: without it two column ranks both read the old
    // config and the second write drops the first column's order.
    const lock = db.dialect === "postgres" ? " FOR UPDATE" : "";
    const row = (await tx.get(`SELECT config_json FROM boards WHERE id = ?${lock}`, [boardId])) as
      | { config_json: string }
      | undefined;
    if (!row) throw new NotFoundError("Board not found");
    let config: BoardConfig;
    try {
      config = JSON.parse(row.config_json);
    } catch {
      config = { dimension: "folder" };
    }
    config.ranks = { ...(config.ranks ?? {}), [key]: order };
    const clean = cleanConfig(config);
    await tx.run("UPDATE boards SET config_json = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(clean),
      now(),
      boardId,
    ]);
  });
  return getVisible(nestId, boardId, userId);
}

export async function deleteBoard(
  nestId: string,
  boardId: string,
  userId: string,
  permission: NestPermission,
): Promise<void> {
  const board = await getVisible(nestId, boardId, userId);
  const isCaretaker = permission === "owner" || permission === "admin";
  if (board.created_by !== userId && !isCaretaker) {
    throw new ForbiddenError("Only the board's creator or a nest admin can delete it");
  }
  await getDb().run("DELETE FROM boards WHERE id = ?", [boardId]);
}
