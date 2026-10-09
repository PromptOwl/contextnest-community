/**
 * Board fields — assignee, due date, priority, parent — stored as ordinary
 * `metadata` keys on any node, and the timestamps that go with them.
 *
 * Any node can carry them (a document on a board can be assigned too); the
 * `task` type is what changes governance — see autoPublishReason. Pure apart
 * from the roster/parent lookups the caller injects, so the rules are testable
 * without a nest.
 *
 * Patch semantics match schedule/prime: `undefined` leaves a field alone,
 * `null` clears it. The engine's context_update merges metadata and reads null
 * as "clear this key", so the returned `opMetadata` is handed straight to it.
 */
import { ValidationError } from "../shared/errors.js";

/** The node type that skips review. Board work moves too often to gate. */
export const TASK_NODE_TYPE: string = "task";

/** Linear's four levels, most urgent first. Absent = no priority. */
export const TASK_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface TaskFieldsPatch {
  /** Email of someone on the nest's roster. */
  assignee?: string | null;
  /** Calendar date, YYYY-MM-DD. */
  due?: string | null;
  priority?: string | null;
  /** Id of the parent node in the same nest — makes this a sub-item. */
  parent?: string | null;
}

/** What a node response exposes. Timestamps are server-stamped, never sent. */
export interface TaskFields {
  assignee?: string;
  /** When the current assignee was set. */
  assigned_at?: string;
  due?: string;
  priority?: TaskPriority;
  parent?: string;
  /** When the node last changed column on a board (its tags changed). */
  moved_at?: string;
  /** When the task entered a "done" column (nest done_tags); cleared on leaving. */
  completed_at?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export function hasTaskFieldsPatch(p: TaskFieldsPatch): boolean {
  return (
    p.assignee !== undefined ||
    p.due !== undefined ||
    p.priority !== undefined ||
    p.parent !== undefined
  );
}

/** Read the board fields off stored metadata, dropping anything malformed so a
 *  hand-edited vault can't hand clients a shape they don't expect. */
export function taskFieldsOf(metadata: unknown): TaskFields {
  const m = (metadata && typeof metadata === "object" ? metadata : {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown) =>
    v === undefined || v === null || v === "" ? undefined : String(v);
  const out: TaskFields = {};
  const assignee = str(m.assignee);
  if (assignee) out.assignee = assignee;
  const assignedAt = str(m.assigned_at);
  if (assignedAt) out.assigned_at = assignedAt;
  // YAML reads a bare 2026-10-10 as a Date — normalize back to the day.
  const dueRaw = m.due instanceof Date ? m.due.toISOString().slice(0, 10) : str(m.due);
  if (dueRaw && DATE_RE.test(dueRaw)) out.due = dueRaw;
  const priority = str(m.priority);
  if (priority && (TASK_PRIORITIES as readonly string[]).includes(priority)) {
    out.priority = priority as TaskPriority;
  }
  const parent = str(m.parent);
  if (parent) out.parent = parent;
  const movedAt = str(m.moved_at);
  if (movedAt) out.moved_at = movedAt;
  const completedAt = str(m.completed_at);
  if (completedAt) out.completed_at = completedAt;
  return out;
}

export interface TaskFieldsContext {
  nodeId: string | null;
  /** Lower-cased emails of everyone on the nest's roster. */
  roster: () => Promise<Set<string>>;
  /** Whether a node id exists in this nest. */
  nodeExists: (id: string) => Promise<boolean>;
  /** Parent of a node, for cycle detection; null at the top. */
  parentOf: (id: string) => Promise<string | null>;
  now: string;
}

/**
 * Validate a patch against the node's current metadata and return the merged
 * metadata (for the local projection) and the minimal op patch (for the
 * engine). Stamps `assigned_at` whenever the assignee actually changes.
 */
export async function applyTaskFields(
  current: Record<string, unknown>,
  patch: TaskFieldsPatch,
  ctx: TaskFieldsContext,
): Promise<{ metadata: Record<string, unknown>; opMetadata: Record<string, unknown> }> {
  const metadata = { ...current };
  const op: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v === null) delete metadata[k];
    else metadata[k] = v;
    op[k] = v;
  };

  if (patch.assignee !== undefined) {
    const next =
      patch.assignee === null || String(patch.assignee).trim() === ""
        ? null
        : String(patch.assignee).trim().toLowerCase();
    if (next !== null) {
      if (!EMAIL_RE.test(next)) {
        throw new ValidationError(`assignee must be an email address, got "${patch.assignee}"`);
      }
      if (!(await ctx.roster()).has(next)) {
        throw new ValidationError(
          `${next} isn't on this nest — share the nest with them before assigning`,
        );
      }
    }
    const prev = current.assignee == null ? null : String(current.assignee).toLowerCase();
    if (next !== prev) {
      set("assignee", next);
      set("assigned_at", next === null ? null : ctx.now);
    }
  }

  if (patch.due !== undefined) {
    const next = patch.due === null || patch.due === "" ? null : String(patch.due);
    if (next !== null && (!DATE_RE.test(next) || Number.isNaN(Date.parse(next)))) {
      throw new ValidationError(`due must be a date like 2026-10-31, got "${patch.due}"`);
    }
    set("due", next);
  }

  if (patch.priority !== undefined) {
    const next =
      patch.priority === null || patch.priority === "" ? null : String(patch.priority);
    if (next !== null && !(TASK_PRIORITIES as readonly string[]).includes(next)) {
      throw new ValidationError(
        `priority must be one of ${TASK_PRIORITIES.join(", ")}, got "${patch.priority}"`,
      );
    }
    set("priority", next);
  }

  if (patch.parent !== undefined) {
    const next = patch.parent === null || patch.parent === "" ? null : String(patch.parent);
    if (next !== null) {
      if (next === ctx.nodeId) throw new ValidationError("a node can't be its own parent");
      if (!(await ctx.nodeExists(next))) {
        throw new ValidationError(`parent ${next} doesn't exist in this nest`);
      }
      // Walk up from the new parent: reaching this node means a cycle. Bounded
      // so a corrupt chain can't spin forever.
      if (ctx.nodeId) {
        let cur: string | null = next;
        for (let i = 0; cur && i < 50; i++) {
          if (cur === ctx.nodeId) {
            throw new ValidationError("that parent would make a cycle of sub-items");
          }
          cur = await ctx.parentOf(cur);
        }
      }
    }
    set("parent", next);
  }

  return { metadata, opMetadata: op };
}
