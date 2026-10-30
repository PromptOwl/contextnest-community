/**
 * Bulk edit — one patch applied to many nodes (the board List view's bulk
 * actions, REST POST /nests/:id/nodes/bulk-update, MCP context_bulk_update).
 *
 * Not a transaction, and not a shortcut around governance: every node goes
 * through updateNode on its own — its own write lock, its own version, its
 * own done-column stamping (completed_at) — exactly as if it had been edited
 * by hand. The differences are deliberate:
 *
 *   - publish or nothing (WriteOptions.publishOnly). A node whose change would
 *     land as a draft for a reviewer — a prime document, a governed document
 *     without a bypass, one under the caller's own open review — is skipped
 *     and reported, never silently turned into a draft. One confirmation must
 *     not fan out into a pile of review requests nobody asked for.
 *   - per-node permission. A node the caller can't edit is skipped; one they
 *     can't read is reported as not found, so a bulk call can't probe for ids.
 *   - a node the patch wouldn't change is reported `unchanged` and not
 *     written, so re-running a batch doesn't mint empty versions.
 *
 * The response names every node with its outcome, which is what makes a
 * non-transactional batch defensible (same contract as bulk publish).
 */
import { DocumentNotFoundError } from "@promptowl/contextnest-engine";
import { engineCache, sealedFor } from "./engine.js";
import { updateNode } from "./service.js";
import * as versions from "../governance/version-service.js";
import { isDueDate, taskFieldsOf, TASK_PRIORITIES } from "./task-fields.js";
import { canReadNode } from "../governance/access-guard.js";
import { canUserEdit } from "../governance/stewardship-service.js";
import { listNestPeople } from "../nests/people-service.js";
import { getBoard } from "../nests/board-service.js";
import { resolvedColumns, UNCATEGORIZED } from "../nests/board-items.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  LockedError,
  NotFoundError,
  ReviewRequiredError,
  ValidationError,
} from "../shared/errors.js";

/** Most nodes one call may touch. Each is a full governed write (lock, engine
 *  write, version row), so this bounds a request to seconds, not minutes. */
export const BULK_UPDATE_MAX = 100;
/** Most raw selector matches one call will permission-check. */
const BULK_SELECTOR_SCAN_MAX = 2000;
const MAX_TAGS = 50;

export interface BulkPatch {
  /** Tags to add (with or without "#"). */
  add_tags?: string[];
  /** Tags to remove. */
  remove_tags?: string[];
  /** Move into this column of `board_id` — a tag column swaps the column tag
   *  (so done columns complete tasks), an assignee/priority column sets it. */
  board_id?: string;
  column?: string;
  priority?: string | null;
  /** Email of someone on the nest; null unassigns. */
  assignee?: string | null;
  /** YYYY-MM-DD; null clears. */
  due?: string | null;
  change_note?: string;
}

export type BulkOutcome = "updated" | "unchanged" | "skipped" | "failed";
export type BulkReasonCode =
  | "needs_review"
  | "locked"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "error";

export interface BulkRowResult {
  id: string;
  title?: string;
  outcome: BulkOutcome;
  code?: BulkReasonCode;
  reason?: string;
  version?: number;
  status?: string;
  completed_at?: string | null;
}

export interface BulkUpdateResult {
  requested: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  results: BulkRowResult[];
}

const asStored = (t: string) => `#${String(t).trim().replace(/^#+/, "").toLowerCase()}`;

function tagList(v: unknown, what: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((t) => typeof t !== "string")) {
    throw new ValidationError(`${what} must be a list of tags`);
  }
  if (v.length > MAX_TAGS) throw new ValidationError(`${what} has more than ${MAX_TAGS} tags`);
  return [...new Set((v as string[]).map((t) => t.trim()).filter(Boolean).map(asStored))];
}

/** Shape-check a patch. Unknown keys are refused, so a typo can't no-op. */
export function cleanBulkPatch(raw: unknown): BulkPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("patch must be an object");
  }
  const r = raw as Record<string, unknown>;
  const known = ["add_tags", "remove_tags", "board_id", "column", "priority", "assignee", "due", "change_note"];
  const unknown = Object.keys(r).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new ValidationError(`patch has unknown field(s): ${unknown.join(", ")} — allowed: ${known.join(", ")}`);
  }
  const out: BulkPatch = {};
  const add = tagList(r.add_tags, "patch.add_tags");
  const remove = tagList(r.remove_tags, "patch.remove_tags");
  if (add?.length) out.add_tags = add;
  if (remove?.length) out.remove_tags = remove;
  if (r.column !== undefined || r.board_id !== undefined) {
    if (typeof r.board_id !== "string" || !r.board_id) {
      throw new ValidationError("patch.column needs patch.board_id — the board whose column it is");
    }
    if (typeof r.column !== "string") throw new ValidationError("patch.column must be a column key");
    out.board_id = r.board_id;
    out.column = r.column;
  }
  if (r.priority !== undefined) {
    if (r.priority !== null && !(TASK_PRIORITIES as readonly unknown[]).includes(r.priority)) {
      throw new ValidationError(`patch.priority must be one of ${TASK_PRIORITIES.join(", ")} or null`);
    }
    out.priority = r.priority as string | null;
  }
  if (r.due !== undefined) {
    if (r.due !== null && (typeof r.due !== "string" || !isDueDate(r.due))) {
      throw new ValidationError("patch.due must be a date like 2026-10-31, or null");
    }
    out.due = r.due as string | null;
  }
  if (r.assignee !== undefined) {
    if (r.assignee !== null && typeof r.assignee !== "string") {
      throw new ValidationError("patch.assignee must be an email or null");
    }
    out.assignee = r.assignee === null || !String(r.assignee).trim() ? null : String(r.assignee).trim().toLowerCase();
  }
  if (r.change_note !== undefined) {
    if (typeof r.change_note !== "string") throw new ValidationError("patch.change_note must be a string");
    out.change_note = r.change_note.slice(0, 500);
  }
  const ops = ["add_tags", "remove_tags", "column", "priority", "assignee", "due"] as const;
  if (!ops.some((k) => out[k] !== undefined)) {
    throw new ValidationError(`patch changes nothing — set one of ${ops.join(", ")}`);
  }
  return out;
}

/** What moving into a board column means, as tag/field operations. */
interface ColumnOp {
  /** Tags to drop: exact stored tags, plus every tag under `dropPrefix`. */
  drop: Set<string>;
  dropPrefix?: string;
  add?: string;
  fields?: { assignee?: string | null; priority?: string | null };
}

async function columnOp(nestId: string, userId: string, boardId: string, column: string): Promise<ColumnOp> {
  const board = await getBoard(nestId, boardId, userId);
  const c = board.config;
  const none = column === UNCATEGORIZED || column === "";
  switch (c.dimension) {
    case "assignee":
      return { drop: new Set(), fields: { assignee: none ? null : column.toLowerCase() } };
    case "priority":
      if (!none && !(TASK_PRIORITIES as readonly string[]).includes(column)) {
        throw new ValidationError(`"${column}" isn't a priority column`);
      }
      return { drop: new Set(), fields: { priority: none ? null : column } };
    case "status":
      throw new ValidationError(
        "Status moves through review, not the board — submit or approve the documents instead.",
      );
    case "folder":
      throw new ValidationError("Folder boards move documents between folders — use context_move per document.");
    case "field":
      // ponytail: refused, not mapped — a multi-select move swaps the one
      // option per node. Set custom fields per document with context_update
      // `fields`; map it here if bulk field moves are asked for.
      throw new ValidationError(
        "Custom-field boards aren't a bulk move target yet — set the field per document (context_update `fields`).",
      );
    case "tag": {
      const ns = (c.tagNamespace ?? "").trim().split(":")[0]!.trim();
      const cols = resolvedColumns(c);
      const target = column.replace(/^#/, "");
      if (ns) {
        // Grouped by stage:* — a node sits in exactly the stage it carries.
        return { drop: new Set(), dropPrefix: asStored(`${ns}:`), add: none ? undefined : asStored(`${ns}:${target}`) };
      }
      if (none) throw new ValidationError("Pick a tag column to move into.");
      // Curated board: its columns are the listed tags, so leaving one is
      // dropping that tag. An auto board (every tag a column) only adds.
      const drop = new Set(
        cols.explicit ? (cols.order ?? []).filter((k) => k !== target).map(asStored) : [],
      );
      return { drop, add: asStored(target) };
    }
  }
}

/** The ids a call targets: an explicit list, or what a selector resolves to. */
async function resolveTargets(
  nestId: string,
  caller: { userId: string; userEmail: string },
  input: { ids?: unknown; selector?: unknown },
): Promise<string[]> {
  if (input.ids !== undefined && input.selector !== undefined) {
    throw new ValidationError("Send ids or a selector, not both");
  }
  let ids: string[];
  if (input.selector !== undefined) {
    if (typeof input.selector !== "string" || !input.selector.trim()) {
      throw new ValidationError("selector must be a non-empty string, e.g. #sprint-12");
    }
    // The selector runs over context.yaml: seal queued writes first.
    await sealedFor(nestId);
    const { query } = await engineCache.get(nestId);
    const res = await query.query(input.selector.trim(), { hops: 0 });
    // Each match costs a permission check, so a selector over a whole nest is
    // refused before the loop instead of checked match by match. No count in
    // the message: it would include matches the caller can't read.
    if (res.documents.length > BULK_SELECTOR_SCAN_MAX) {
      throw new ValidationError("This selector matches too many documents for a bulk update. Narrow the selector.");
    }
    // Only what the caller can read: matches they can't see are neither
    // targeted nor counted (the over-cap message below must not leak them).
    // One past the cap is enough to refuse, so the loop stops there.
    ids = [];
    for (const d of res.documents) {
      if (await canReadNode(nestId, d.id, caller.userId, caller.userEmail)) ids.push(d.id);
      if (ids.length > BULK_UPDATE_MAX) {
        throw new ValidationError(
          `A bulk update takes at most ${BULK_UPDATE_MAX} nodes; this selector matches more. Narrow the selector.`,
        );
      }
    }
  } else {
    if (!Array.isArray(input.ids) || input.ids.some((x) => typeof x !== "string" || !x)) {
      throw new ValidationError("ids must be a list of node ids");
    }
    ids = input.ids as string[];
  }
  ids = [...new Set(ids)];
  if (ids.length === 0) throw new ValidationError("No nodes to update");
  if (ids.length > BULK_UPDATE_MAX) {
    throw new ValidationError(
      `A bulk update takes at most ${BULK_UPDATE_MAX} nodes; this one has ${ids.length}. Split it, or narrow the selector.`,
    );
  }
  return ids;
}

export const reasonOf = (err: unknown): { code: BulkReasonCode; reason: string; outcome: BulkOutcome } => {
  const reason = err instanceof Error ? err.message : String(err);
  if (err instanceof ReviewRequiredError) return { code: "needs_review", reason, outcome: "skipped" };
  if (err instanceof LockedError) return { code: "locked", reason, outcome: "skipped" };
  if (err instanceof ForbiddenError) return { code: "forbidden", reason, outcome: "skipped" };
  if (err instanceof NotFoundError) return { code: "not_found", reason, outcome: "skipped" };
  if (err instanceof ConflictError) return { code: "conflict", reason, outcome: "skipped" };
  if (err instanceof ValidationError) return { code: "invalid", reason, outcome: "failed" };
  if (err instanceof AppError) return { code: "error", reason, outcome: "failed" };
  // Not surfaced to the caller (it may carry internals) — logged instead.
  console.error("bulk update row failed", err);
  return { code: "error", reason: "Couldn't save this one — try it again on its own.", outcome: "failed" };
};

export async function bulkUpdateNodes(
  nestId: string,
  caller: { userId: string; userEmail: string },
  input: { ids?: unknown; selector?: unknown; patch?: unknown },
  opts: {
    client?: ClientMetadata;
    /** Save as a draft for review where the document needs one (what a single
     *  edit does), instead of skipping it. Document-list tagging sets this; a
     *  document under someone else's open review is still locked. */
    allowDraft?: boolean;
  } = {},
): Promise<BulkUpdateResult> {
  const patch = cleanBulkPatch(input.patch);
  const ids = await resolveTargets(nestId, caller, input);
  const col = patch.board_id ? await columnOp(nestId, caller.userId, patch.board_id, patch.column!) : null;
  const fields = { ...col?.fields };
  for (const k of ["assignee", "priority", "due"] as const) {
    if (patch[k] !== undefined) (fields as Record<string, unknown>)[k] = patch[k];
  }
  // Checked once, up front: a typo'd assignee is the request's mistake, not
  // a hundred per-node failures.
  if (fields.assignee) {
    const roster = new Set((await listNestPeople(nestId)).map((p) => p.email.toLowerCase()));
    if (!roster.has(fields.assignee)) {
      throw new ValidationError(`${fields.assignee} isn't on this nest — share the nest with them before assigning`);
    }
  }
  const add = new Set([...(patch.add_tags ?? []), ...(col?.add ? [col.add] : [])]);
  const remove = new Set([...(patch.remove_tags ?? []), ...(col?.drop ?? [])]);

  const { storage } = await engineCache.get(nestId);
  const results: BulkRowResult[] = [];
  for (const rawId of ids) {
    let id = rawId;
    try {
      id = assertSafeNodeId(rawId);
    } catch (err) {
      results.push({ id: rawId, ...reasonOf(err) });
      continue;
    }
    // Unreadable reads exactly like missing — a bulk call is not an oracle.
    if (!(await canReadNode(nestId, id, caller.userId, caller.userEmail))) {
      results.push({ id, outcome: "skipped", code: "not_found", reason: "Node not found" });
      continue;
    }
    // The head we computed the change from. The write refuses (inside the
    // node lock) if anyone saved in between, instead of overwriting their
    // tags with a set derived from the older read.
    let head: number;
    let node;
    try {
      head = await versions.getCurrentVersion(nestId, id);
      node = await storage.readDocument(id);
    } catch (err) {
      // Only a missing document reads as not_found; an IO error or lock
      // timeout is reported as what it is.
      const missing =
        err instanceof DocumentNotFoundError ||
        err instanceof NotFoundError ||
        (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
      results.push(
        missing
          ? { id, outcome: "skipped", code: "not_found", reason: "Node not found" }
          : { id, ...reasonOf(err) },
      );
      continue;
    }
    const title = String(node.frontmatter.title ?? id);
    const edit = await canUserEdit(nestId, id, caller.userEmail);
    if (!edit.allowed) {
      results.push({ id, title, outcome: "skipped", code: "forbidden", reason: `You can't edit this: ${edit.reason}` });
      continue;
    }

    // Only what actually changes goes into the write. Tags this patch doesn't
    // touch are passed back exactly as stored; matching is on the stored form.
    const before = ((node.frontmatter.tags ?? []) as unknown[]).map((t) => String(t));
    const beforeKeys = new Set(before.map(asStored));
    const drop = (t: string) => {
      const k = asStored(t);
      return remove.has(k) || (!!col?.dropPrefix && k.startsWith(col.dropPrefix) && k !== col.add);
    };
    const next = before.filter((t) => !drop(t));
    const nextKeys = new Set(next.map(asStored));
    for (const t of add) {
      if (!nextKeys.has(t)) {
        next.push(t);
        nextKeys.add(t);
      }
    }
    const tagsChanged =
      nextKeys.size !== beforeKeys.size || [...nextKeys].some((t) => !beforeKeys.has(t));
    const current = taskFieldsOf(node.frontmatter.metadata) as Record<string, unknown>;
    const changedFields: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(fields)) {
      if ((current[k] ?? null) !== (v ?? null)) changedFields[k] = v as string | null;
    }
    if (!tagsChanged && Object.keys(changedFields).length === 0) {
      results.push({ id, title, outcome: "unchanged", status: String(node.frontmatter.status ?? "") });
      continue;
    }
    try {
      const { node: saved, version } = await updateNode(
        nestId,
        id,
        {
          ...(tagsChanged ? { tags: next } : {}),
          ...changedFields,
          changeNote: patch.change_note || "Bulk edit",
          client: opts.client,
        },
        caller.userEmail,
        { publishOnly: !opts.allowDraft, expectHead: head },
      );
      results.push({
        id,
        title,
        outcome: "updated",
        version,
        status: String(saved.frontmatter.status ?? ""),
        completed_at: taskFieldsOf(saved.frontmatter.metadata).completed_at ?? null,
      });
    } catch (err) {
      results.push({ id, title, ...reasonOf(err) });
    }
  }

  const count = (o: BulkOutcome) => results.filter((r) => r.outcome === o).length;
  // Nothing editable at all is a refusal, not a report of N skips — it's what
  // a read-only caller gets, and it should read as one.
  if (results.length > 0 && results.every((r) => r.code === "forbidden" || r.code === "not_found") && results.some((r) => r.code === "forbidden")) {
    throw new ForbiddenError("You don't have edit access to any of these documents.");
  }
  return {
    requested: ids.length,
    updated: count("updated"),
    unchanged: count("unchanged"),
    skipped: count("skipped"),
    failed: count("failed"),
    results,
  };
}

