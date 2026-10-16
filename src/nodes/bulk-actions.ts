/**
 * Bulk move and bulk delete over an explicit list of documents (REST
 * POST /nests/:id/nodes/bulk-move and bulk-delete, MCP context_move and
 * context_delete with `ids`). Tags go through bulk-update (`add_tags`).
 *
 * Same contract as bulk-update: not a transaction, and not a shortcut. Every
 * document goes through moveNode / deleteNode on its own, so the review
 * freeze, structure rules, PDF refusal and tombstones apply exactly as for a
 * single document. A document the caller can't edit is skipped (a delete
 * points at the deletion-request path instead), one they can't read is
 * reported as not found, and every document gets its own row in the result.
 */
import { DocumentNotFoundError } from "@promptowl/contextnest-engine";
import { engineCache } from "./engine.js";
import { moveNode, deleteNode } from "./service.js";
import { BULK_UPDATE_MAX, reasonOf, type BulkRowResult } from "./bulk-update.js";
import { canReadNode } from "../governance/access-guard.js";
import { canUserEdit } from "../governance/stewardship-service.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { ForbiddenError, ValidationError } from "../shared/errors.js";

export interface BulkActionRow extends BulkRowResult {
  /** Where a moved document went. */
  new_id?: string;
}

export interface BulkActionResult {
  requested: number;
  /** Moved or deleted. */
  done: number;
  unchanged: number;
  skipped: number;
  failed: number;
  results: BulkActionRow[];
}

type Caller = { userId: string; userEmail: string };

function cleanIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !x)) {
    throw new ValidationError("ids must be a list of node ids");
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length === 0) throw new ValidationError("No nodes selected");
  if (ids.length > BULK_UPDATE_MAX) {
    throw new ValidationError(`A bulk action takes at most ${BULK_UPDATE_MAX} nodes; this one has ${ids.length}. Split it.`);
  }
  return ids;
}

async function runBulk(
  nestId: string,
  caller: Caller,
  rawIds: unknown,
  verb: "move" | "delete",
  act: (id: string) => Promise<Partial<BulkActionRow>>,
): Promise<BulkActionResult> {
  const ids = cleanIds(rawIds);
  const { storage } = await engineCache.get(nestId);
  const results: BulkActionRow[] = [];
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
    let title: string;
    try {
      title = String((await storage.readDocument(id)).frontmatter.title ?? id);
    } catch (err) {
      const missing = err instanceof DocumentNotFoundError || (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
      results.push(missing ? { id, outcome: "skipped", code: "not_found", reason: "Node not found" } : { id, ...reasonOf(err) });
      continue;
    }
    const edit = await canUserEdit(nestId, id, caller.userEmail);
    if (!edit.allowed) {
      results.push({
        id,
        title,
        outcome: "skipped",
        code: "forbidden",
        reason:
          `You can't ${verb} this: ${edit.reason}` +
          (verb === "delete" ? " Ask a nest owner/admin to delete it (request deletion)." : ""),
      });
      continue;
    }
    try {
      results.push({ id, title, ...(await act(id)) });
    } catch (err) {
      results.push({ id, title, ...reasonOf(err) });
    }
  }
  const count = (o: BulkActionRow["outcome"]) => results.filter((r) => r.outcome === o).length;
  // Nothing editable at all reads as a refusal, as in bulk-update.
  if (results.every((r) => r.code === "forbidden" || r.code === "not_found") && results.some((r) => r.code === "forbidden")) {
    throw new ForbiddenError(`You don't have edit access to any of these documents.`);
  }
  return {
    requested: ids.length,
    done: count("updated"),
    unchanged: count("unchanged"),
    skipped: count("skipped"),
    failed: count("failed"),
    results,
  };
}

export function bulkMoveNodes(nestId: string, caller: Caller, input: { ids?: unknown; folder?: unknown }) {
  if (typeof input.folder !== "string") {
    throw new ValidationError('folder (a string; "" for the nest root) is required');
  }
  const folder = input.folder;
  return runBulk(nestId, caller, input.ids, "move", async (id) => {
    const { node, previousId } = await moveNode(nestId, id, folder, caller.userEmail);
    return previousId === node.id
      ? { outcome: "unchanged" }
      : { outcome: "updated", new_id: node.id };
  });
}

export function bulkDeleteNodes(
  nestId: string,
  caller: Caller,
  input: { ids?: unknown },
  opts: { client?: ClientMetadata } = {},
) {
  return runBulk(nestId, caller, input.ids, "delete", async (id) => {
    await deleteNode(nestId, id, caller.userEmail, { client: opts.client });
    return { outcome: "updated" };
  });
}
