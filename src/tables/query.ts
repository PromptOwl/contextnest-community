/**
 * Governed table lookup — shared by REST (/table-query) and MCP
 * (context_table_query). Resolution mirrors /context: [[Title]] matches
 * case-insensitively over VISIBLE docs (published unless include_drafts);
 * a bare ref is a node id.
 *
 * A table query is a node read, so it is gated like one. Before any rows are
 * served the caller must pass `canReadNode` — the gate `GET /nodes/:id` uses —
 * and, where that read would serve the approved version (a public/org reader,
 * or an agent on a governed nest), the rows come from the approved version
 * too, not the live working copy. Without both, a caller who cannot open a
 * table could still read it one query at a time, pending rows included.
 */
import type { ContextNode } from "@promptowl/contextnest-engine";
import { engineCache } from "../nodes/engine.js";
import { bodyOnly } from "../nodes/service.js";
import { canReadNode } from "../governance/access-guard.js";
import { getApprovedVersion } from "../governance/version-service.js";
import { reconstructApproved } from "../governance/approved-body.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../shared/errors.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { parseTable, parseQuery, runQuery, type RefResolver } from "./service.js";
import { callerRefResolver } from "./refs.js";

export interface TableQueryResult {
  table: string;
  version: number | null;
  columns: string[];
  rows: string[][];
  matched: number;
  returned: number;
  total: number;
}

/** Who is asking, and which version their read is entitled to. */
export interface TableQueryCaller {
  userId: string;
  userEmail: string;
  /**
   * Serve the approved version's rows only. REST sets this for public/org
   * readers (what GET /nodes/:id serves them); MCP sets it whenever the nest
   * is governed or the caller is a public reader (what every MCP read serves).
   */
  approvedOnly: boolean;
}

export async function queryTableNode(
  nestId: string,
  ref: string,
  q: string,
  includeDrafts: boolean,
  caller: TableQueryCaller,
): Promise<TableQueryResult> {
  const { storage, versions: versionManager } = await engineCache.get(nestId);
  // Under approvedOnly, "visible" means "has an approved version" (checked
  // below) — the frontmatter status is the working copy's claim, not a review
  // outcome, and a never-approved table can carry `status: published`.
  const isVisible = (d: ContextNode) =>
    caller.approvedOnly || includeDrafts || d.frontmatter.status === "published";
  const canRead = (id: string) =>
    canReadNode(nestId, id, caller.userId, caller.userEmail);

  let doc: ContextNode | undefined;
  const m = /^\[\[(.+)\]\]$/.exec(ref.trim());
  if (m) {
    // A title names no node until it resolves, so the gate runs per match. A
    // match the caller cannot read is skipped, not refused: answering "denied"
    // for a title that exists and "not found" for one that doesn't would tell
    // a restricted caller which tables the nest holds.
    const wanted = m[1].trim().toLowerCase();
    const all = await storage.discoverDocuments();
    for (const d of all) {
      if (String(d.frontmatter.title || "").toLowerCase() !== wanted) continue;
      if (!isVisible(d)) continue;
      if (!(await canRead(d.id))) continue;
      doc = d;
      break;
    }
  } else {
    // Gate BEFORE the read, as getNodeForCaller does: a restricted id and a
    // missing one must look identical, so the denial cannot depend on whether
    // the document exists.
    // The ref comes from the request BODY, so the router's :nodeId containment
    // guard never saw it — and readDocument joins it onto the nest root as
    // given. Contain it here, or `../<otherNest>/nodes/x` reads another nest.
    const id = assertSafeNodeId(ref.trim());
    if (!(await canRead(id))) {
      throw new ForbiddenError("Access denied — no steward assignment for this node");
    }
    try {
      doc = await storage.readDocument(id);
    } catch {
      /* handled below */
    }
    if (doc && !isVisible(doc)) doc = undefined;
  }
  if (!doc) throw new NotFoundError(`Table not found: ${ref}`);
  if ((doc.frontmatter.type as string) !== "table") {
    throw new ValidationError(
      `"${doc.id}" is type "${doc.frontmatter.type || "document"}" — table-query only reads table nodes`,
    );
  }

  let body = doc.body || "";
  let version = (doc.frontmatter.version as number) ?? null;
  if (caller.approvedOnly) {
    const approved = await getApprovedVersion(nestId, doc.id);
    if (approved == null) throw new NotFoundError(`Table not found: ${ref}`);
    const rebuilt = await reconstructApproved(versionManager, nestId, doc.id, approved);
    body = bodyOnly(doc.id, rebuilt.raw);
    version = rebuilt.version;
  }

  const parsed = parseTable(body);
  const query = parseQuery(q);
  // `=`/`!=` on a :ref column compare resolved targets. Resolve over what THIS
  // caller can read only, so a hidden node's title can't be used to probe
  // which rows point at it — under the same visibility as the table lookup
  // (published unless include_drafts), and, for an approved-only reader, by
  // id/slug only: a working-copy title may be an unapproved rename. Ref
  // matches therefore depend on the nest's documents as well as the table's
  // version (see API.md, Table :ref columns). Built only when a condition needs it — a ref-less
  // query never pays for the nest scan.
  const refCols = new Set(
    parsed.columns.filter((c) => c.ref).map((c) => c.name.toLowerCase()),
  );
  let resolveRef: RefResolver | undefined;
  if (query.where.some((w) => refCols.has(w.column.toLowerCase()))) {
    resolveRef = await callerRefResolver(nestId, caller.userId, caller.userEmail, {
      approvedOnly: caller.approvedOnly,
      publishedOnly: !caller.approvedOnly && !includeDrafts,
    });
  }
  const result = runQuery(parsed, query, resolveRef);
  return {
    table: doc.id,
    version,
    columns: result.columns,
    rows: result.rows,
    matched: result.matched,
    returned: result.rows.length,
    total: result.total,
  };
}
