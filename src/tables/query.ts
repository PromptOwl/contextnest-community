/**
 * Governed table lookup — shared by REST (/table-query) and MCP
 * (context_table_query). Resolution mirrors /context: [[Title]] matches
 * case-insensitively over VISIBLE docs (published unless include_drafts);
 * a bare ref is a node id.
 */
import type { ContextNode } from "@promptowl/contextnest-engine";
import { engineCache } from "../nodes/engine.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { parseTable, parseQuery, runQuery } from "./service.js";

export interface TableQueryResult {
  table: string;
  version: number | null;
  columns: string[];
  rows: string[][];
  matched: number;
  returned: number;
  total: number;
}

export async function queryTableNode(
  nestId: string,
  ref: string,
  q: string,
  includeDrafts = false,
): Promise<TableQueryResult> {
  const { storage } = await engineCache.get(nestId);
  const isVisible = (d: ContextNode) =>
    includeDrafts || d.frontmatter.status === "published";

  let doc: ContextNode | undefined;
  const m = /^\[\[(.+)\]\]$/.exec(ref.trim());
  if (m) {
    const wanted = m[1].trim().toLowerCase();
    const all = await storage.discoverDocuments();
    doc = all.find(
      (d: ContextNode) =>
        String(d.frontmatter.title || "").toLowerCase() === wanted && isVisible(d),
    );
  } else {
    try {
      doc = await storage.readDocument(ref.trim());
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

  const parsed = parseTable(doc.body || "");
  const result = runQuery(parsed, parseQuery(q));
  return {
    table: doc.id,
    version: (doc.frontmatter.version as number) ?? null,
    columns: result.columns,
    rows: result.rows,
    matched: result.matched,
    returned: result.rows.length,
    total: result.total,
  };
}
