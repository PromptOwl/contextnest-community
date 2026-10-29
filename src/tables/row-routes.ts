/**
 * POST /nests/:nestId/nodes/:nodeId/rows — row ops on a table node.
 *
 *   { ops: [ {op:"append",row:{…}} | {op:"update",key,set:{…}} | {op:"delete",key} ],
 *     base_version?: number, submit_review?: boolean, change_note?: string }
 *
 * The ops are applied to the table's working copy (row-ops.ts: typed,
 * all-or-nothing, minimal line edits) and the new body is written through
 * `updateNode` — the same update/governance path a PATCH of the body takes.
 * So who may write is decided exactly as for a body edit (the nest guard
 * admits write-tier callers, a write grant on the node, or an editor steward
 * on it; a reader is refused 403), and what the write becomes is decided by
 * the nest's governance: a draft on a governed nest (optionally submitted for
 * review), a publish otherwise.
 *
 * Concurrency: the version read alongside the body is passed as `expectHead`,
 * checked inside the node's write lock, so a write that lands between this
 * read and ours is refused (409), never overwritten. A caller-supplied
 * `base_version` that is not the current head is refused the same way before
 * anything is applied.
 *
 * A view's write bridge (src/views/write.ts) is one caller of this route; it
 * holds no privilege of its own here — the request carries the viewer's own
 * session, and the checks above are the viewer's.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { engineCache } from "../nodes/engine.js";
import { updateNode } from "../nodes/service.js";
import { canReadNode, resolveCallerEmail } from "../governance/access-guard.js";
import * as versions from "../governance/version-service.js";
import * as reviews from "../governance/review-service.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { ConflictError, NotFoundError, ValidationError } from "../shared/errors.js";
import { applyRowOps, parseRowOps } from "./row-ops.js";

export const tableRowRoutes = new Hono<AuthEnv>();

const MAX_CHANGE_NOTE = 500;

function conflict(c: any, base: number, current: number) {
  return c.json(
    {
      error: "Version conflict",
      message: `The table changed (now v${current}, you sent v${base}). Reload it and try again.`,
      base_version: base,
      current_version: current,
    },
    409,
  );
}

/**
 * Read the head version and the body as one consistent pair: head → body →
 * head, retried while they move. Reading the body first and the head after
 * would let a write land in between, and the ops would be applied to the
 * older body under the newer head — which expectHead then accepts, silently
 * reverting that write. Throws ConflictError if the node keeps moving.
 */
export async function readStable(
  getHead: () => Promise<number>,
  readBody: () => Promise<string>,
  attempts = 3,
): Promise<{ head: number; body: string }> {
  for (let i = 0; i < attempts; i++) {
    const before = await getHead();
    const body = await readBody();
    const after = await getHead();
    if (before === after) return { head: after, body };
  }
  throw new ConflictError("The table changed while it was being read. Reload it and try again.");
}

tableRowRoutes.post("/:nodeId{.+}/rows", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const userId = c.get("userId");
  if (!config.TYPE_TABLE_ENABLED) throw new ValidationError("Table nodes are turned off on this server (TYPE_TABLE_ENABLED=false).");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Body must be JSON: { ops: [...] }");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Body must be a JSON object");
  const ops = parseRowOps(body.ops);
  const base = body.base_version;
  if (base !== undefined && !(typeof base === "number" && Number.isInteger(base) && base >= 0)) {
    throw new ValidationError("base_version must be a non-negative integer");
  }
  const note = body.change_note;
  if (note !== undefined && (typeof note !== "string" || note.length > MAX_CHANGE_NOTE)) {
    throw new ValidationError(`change_note must be a string of at most ${MAX_CHANGE_NOTE} characters`);
  }
  const client = attributeRequest(c, body.client);

  const userEmail = await resolveCallerEmail(userId);
  // A node the caller cannot read is a 404, like a missing one.
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) throw new NotFoundError(`Node not found: ${nodeId}`);
  const { storage } = await engineCache.get(nestId);
  let doc;
  try {
    doc = await storage.readDocument(nodeId);
  } catch {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }
  const type = String(doc.frontmatter.type || "document");
  if (type !== "table") {
    throw new ValidationError(`"${nodeId}" is type "${type}" — row operations only apply to table nodes`);
  }

  // The head and the body the ops apply to must belong together; updateNode's
  // expectHead then refuses anything that lands after this read.
  const { head, body: current } = await readStable(
    () => versions.getCurrentVersion(nestId, nodeId),
    async () => (await storage.readDocument(nodeId)).body || "",
  );
  if (base !== undefined && base !== head) return conflict(c, base, head);

  // The working copy may be someone else's unreviewed draft. Building on it
  // would fold their unseen edits into this write (and, with submit_review,
  // submit them under this caller's name), so it is refused until that draft
  // is submitted, approved or discarded. The caller's own draft is built on.
  const headRow = head > 0 ? await versions.getVersion(nestId, nodeId, head) : null;
  if (
    headRow &&
    String(headRow.status) === "draft" &&
    String(headRow.editedBy ?? "").toLowerCase() !== userEmail.toLowerCase()
  ) {
    return c.json(
      {
        error: "This table has an unreviewed draft by someone else. Ask them to submit or discard it, then try again.",
        code: "draft_in_progress",
        current_version: head,
      },
      409,
    );
  }

  const applied = applyRowOps(current, ops);
  const counts = { appended: applied.appended, updated: applied.updated, deleted: applied.deleted };
  const stateOf = async (v: number) =>
    (await versions.getApprovedVersion(nestId, nodeId)) === v ? "published" : "draft";
  if (!applied.changed) {
    return c.json({ table: nodeId, version: head, state: await stateOf(head), applied: counts, unchanged: true });
  }

  let version: number;
  try {
    ({ version } = await updateNode(
      nestId,
      nodeId,
      {
        content: applied.body,
        changeNote: (note as string | undefined) ?? describe(counts),
        client,
      },
      userEmail,
      { expectHead: head },
    ));
  } catch (err) {
    // expectHead refused: someone wrote between our read and the lock.
    if (err instanceof ConflictError) {
      const now = await versions.getCurrentVersion(nestId, nodeId);
      if (now !== head) return conflict(c, base ?? head, now);
    }
    throw err;
  }

  const state = await stateOf(version);
  let reviewId: string | undefined;
  let reviewError: string | undefined;
  if (state === "draft" && body.submit_review === true && (await isStewardshipEnabled(nestId))) {
    // The author's own open review was repointed to this draft by updateNode.
    const pending = await reviews.getPendingReview(nestId, nodeId);
    if (pending) {
      reviewId = pending.id;
    } else {
      // The write has landed; a failed submission must not read as a failed
      // write (a retry would then append twice). Report it alongside.
      try {
        const request = await reviews.submitForReview({
        nestId,
        nodeId,
        version,
        requestedBy: userEmail,
        note: (note as string | undefined) ?? describe(counts),
        baseUrl: requestBaseUrl(c.req.url),
          client,
        });
        reviewId = request.id;
      } catch (err) {
        reviewError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return c.json({
    table: nodeId,
    version,
    state,
    applied: counts,
    ...(reviewId ? { review_id: reviewId } : {}),
    ...(reviewError ? { review_error: reviewError } : {}),
  });
});

function describe(n: { appended: number; updated: number; deleted: number }): string {
  const parts: string[] = [];
  if (n.appended) parts.push(`${n.appended} added`);
  if (n.updated) parts.push(`${n.updated} updated`);
  if (n.deleted) parts.push(`${n.deleted} deleted`);
  return `Rows: ${parts.join(", ")}`;
}
