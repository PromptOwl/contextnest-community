/**
 * Table nodes — CSV as a governed, queryable content type.
 *
 * A `table` node's body is CSV: header row + data rows. Unlike documents
 * (prose for a model to read), a table is a FACT STORE: the point is
 * deterministic lookup. An agent holding 1,000 rows shouldn't pull them all
 * into context — it queries for the exact rows it needs, and the same query
 * against the same version returns the same rows, always.
 *
 * Header directives declare column semantics inline, colon-suffixed:
 *
 *   sku:key, price:number, launched:date, region
 *
 *   :key     — this column identifies rows (documented intent; also used
 *              as the default sort tiebreak so results are stable)
 *   :number  — values compare numerically in WHERE (
 *              otherwise string compare)
 *   :date    — values compare as ISO dates
 *   :text    — explicit default
 *   :ref     — each cell links the row to a node: `[[Title]]`,
 *              `[[path|label]]` or a bare node id (empty = no link). The
 *              column name is the edge type and the row key attributes it
 *              (see extractTableRefs); `=`/`!=` compare the RESOLVED target,
 *              so `[[AGA]]`, `[[nodes/aga]]` and `nodes/aga` are one value.
 *
 * The query grammar is deliberately tiny (SQL/Cypher feel, no joins, no OR):
 *
 *   where <col> <op> <value> [and <col> <op> <value> …]
 *        [select col1, col2] [limit N]
 *
 *   ops: = != > >= < <= contains
 *
 * AND-only keeps evaluation trivially deterministic and forces complex
 * logic up into the flow graph where it belongs (edges/conditions), not
 * down into a query planner.
 */
import { ValidationError } from "../shared/errors.js";

export type ColumnType = "text" | "number" | "date";

export interface Column {
  name: string;
  type: ColumnType;
  key: boolean;
  /** Set (true) only on `:ref` columns, so a ref-less table parses to the
   *  exact shape it always had. */
  ref?: true;
}

export interface ParsedTable {
  columns: Column[];
  rows: string[][];
}

/** RFC-4180-ish CSV line splitter: quoted cells, doubled-quote escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const DIRECTIVES = new Set(["key", "number", "date", "text", "ref"]);

export function parseTable(body: string): ParsedTable {
  const lines = body
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (!lines.length) {
    throw new ValidationError("table body is empty — expected a CSV header row");
  }
  const columns: Column[] = splitCsvLine(lines[0]).map((raw) => {
    const parts = raw.split(":").map((p) => p.trim());
    const name = parts[0];
    if (!name) throw new ValidationError("empty column name in header");
    let type: ColumnType = "text";
    let key = false;
    let ref = false;
    for (const d of parts.slice(1)) {
      const dl = d.toLowerCase();
      if (!DIRECTIVES.has(dl)) {
        throw new ValidationError(
          `unknown column directive ":${d}" on "${name}" — known: ${[...DIRECTIVES].join(", ")}`,
        );
      }
      if (dl === "key") key = true;
      else if (dl === "ref") ref = true;
      else type = dl as ColumnType;
    }
    return ref ? { name, type, key, ref: true } : { name, type, key };
  });

  const rows = lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    // Ragged rows pad/truncate to the header width — data entry is human.
    while (cells.length < columns.length) cells.push("");
    return cells.slice(0, columns.length);
  });
  return { columns, rows };
}

// ─── Refs ────────────────────────────────────────────────────────────────

const REF_CELL_RE = /^\[\[([^\]|]*)(?:\|[^\]]*)?\]\]$/;

/**
 * The target a ref cell names: the inside of `[[Title]]` / `[[path|label]]`
 * (label dropped), or the trimmed cell itself (a bare node id). Null for an
 * empty cell — a row may leave a ref blank.
 */
export function parseRefTarget(cell: string): string | null {
  return parseRef(cell)?.target ?? null;
}

/**
 * parseRefTarget plus the form it was written in. `bare` (no `[[…]]`) means
 * "a node id": it resolves by exact id ONLY, never by title or slug — a
 * dangling `nodes/clients/aga` must not attach to an unrelated
 * `nodes/prospects/aga` (the same rule graph-service applies to
 * contextnest:// ids).
 */
export function parseRef(cell: string): { target: string; bare: boolean } | null {
  const v = (cell ?? "").trim();
  if (!v) return null;
  const m = REF_CELL_RE.exec(v);
  const target = (m ? m[1] : v).trim();
  return target ? { target, bare: !m } : null;
}

/** One ref cell: the edge type (column), the row it belongs to, the target. */
export interface TableRef {
  column: string;
  /** The row's `:key` value, or `row N` (1-based) when it has none. */
  row: string;
  target: string;
  /** Written as a bare id (no `[[…]]`): resolve by exact id only. */
  bare?: true;
}

/**
 * Every non-empty ref cell, in row then column order. A row is named by its
 * first `:key` column; without one (or with a blank key) it is `row N`, its
 * 1-based position among the data rows.
 */
export function extractTableRefs(table: ParsedTable): TableRef[] {
  const refCols = table.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.ref);
  if (!refCols.length) return [];
  const keyIdx = table.columns.findIndex((c) => c.key);
  const out: TableRef[] = [];
  table.rows.forEach((r, n) => {
    const key = keyIdx >= 0 ? (r[keyIdx] ?? "").trim() : "";
    const row = key || `row ${n + 1}`;
    for (const { c, i } of refCols) {
      const ref = parseRef(r[i] ?? "");
      if (!ref) continue;
      out.push(
        ref.bare
          ? { column: c.name, row, target: ref.target, bare: true }
          : { column: c.name, row, target: ref.target },
      );
    }
  });
  return out;
}

/** Resolves a ref target to a node id, or null when it names no node the
 *  caller can see. `bare` targets (written without `[[…]]`) match by exact
 *  id only. */
export type RefResolver = (target: string, bare: boolean) => string | null;

// ─── Query ───────────────────────────────────────────────────────────────

export type Op = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";

export interface Condition {
  column: string;
  op: Op;
  value: string;
}

export interface TableQuery {
  where: Condition[];
  select: string[] | null; // null = all columns
  limit: number | null;
}

const OPS: Op[] = [">=", "<=", "!=", "=", ">", "<", "contains"];

/**
 * Parse the compact query string. Examples:
 *   where region = "EU" and price > 100 select sku, price limit 5
 *   where sku contains "OWL"
 *   (empty string = all rows)
 */
export function parseQuery(q: string): TableQuery {
  let rest = q.trim();
  const out: TableQuery = { where: [], select: null, limit: null };
  if (!rest) return out;

  const limitMatch = rest.match(/\blimit\s+(\d+)\s*$/i);
  if (limitMatch) {
    out.limit = parseInt(limitMatch[1], 10);
    rest = rest.slice(0, limitMatch.index).trim();
  }
  const selectMatch = rest.match(/\bselect\s+(.+)$/i);
  if (selectMatch) {
    out.select = selectMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
    rest = rest.slice(0, selectMatch.index).trim();
  }
  if (!rest) return out;

  if (!/^where\s/i.test(rest)) {
    throw new ValidationError(
      'query must start with "where" (or be empty for all rows)',
    );
  }
  rest = rest.replace(/^where\s+/i, "");
  // AND-only: split on the keyword, parse each clause independently.
  for (const clause of rest.split(/\s+and\s+/i)) {
    const m = clause.match(
      /^\s*([\w .\-]+?)\s*(>=|<=|!=|=|>|<|contains)\s*(.+)\s*$/i,
    );
    if (!m) {
      throw new ValidationError(
        `can't parse condition "${clause}" — expected <column> <op> <value> with op in ${OPS.join(" ")}`,
      );
    }
    let value = m[3].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.where.push({ column: m[1].trim(), op: m[2].toLowerCase() as Op, value });
  }
  return out;
}

/** A ref value's identity: the node it resolves to, else its written target
 *  (case-folded), so an unresolved ref still equals the same spelling. */
function refIdentity(raw: string, resolve?: RefResolver): string {
  const ref = parseRef(raw);
  if (!ref) return "";
  const id = resolve?.(ref.target, ref.bare);
  return id ? `id:${id}` : `raw:${ref.target.toLowerCase()}`;
}

function compare(
  cell: string,
  cond: Condition,
  type: ColumnType,
  ref: RefMatch | null,
): boolean {
  if (ref && (cond.op === "=" || cond.op === "!=")) {
    const same = refIdentity(cell, ref.resolve) === ref.value;
    return cond.op === "=" ? same : !same;
  }
  if (cond.op === "contains") {
    return cell.toLowerCase().includes(cond.value.toLowerCase());
  }
  let a: number | string = cell;
  let b: number | string = cond.value;
  if (type === "number") {
    a = Number(cell);
    b = Number(cond.value);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
  } else if (type === "date") {
    a = Date.parse(cell);
    b = Date.parse(cond.value);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
  } else {
    a = cell.toLowerCase();
    b = cond.value.toLowerCase();
  }
  switch (cond.op) {
    case "=": return a === b;
    case "!=": return a !== b;
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
  }
}

export interface QueryResult {
  columns: string[];
  rows: string[][];
  matched: number; // pre-limit match count — callers see truncation honestly
  total: number; // table row count
}

interface RefMatch {
  value: string;
  resolve?: RefResolver;
}

/** Evaluate a query against a parsed table. Row order is source order —
 *  stable by construction, which is what makes results replayable.
 *  `resolveRef` lets `=`/`!=` on a `:ref` column compare resolved targets;
 *  without it they compare the written targets. */
export function runQuery(
  table: ParsedTable,
  query: TableQuery,
  resolveRef?: RefResolver,
): QueryResult {
  const colIndex = new Map(table.columns.map((c, i) => [c.name.toLowerCase(), i]));
  const resolve = (name: string): number => {
    const i = colIndex.get(name.toLowerCase());
    if (i === undefined) {
      throw new ValidationError(
        `unknown column "${name}" — table has: ${table.columns.map((c) => c.name).join(", ")}`,
      );
    }
    return i;
  };

  const conds = query.where.map((c) => {
    const idx = resolve(c.column);
    const col = table.columns[idx];
    // The condition's own identity is computed once, not per row.
    const ref: RefMatch | null = col.ref
      ? { value: refIdentity(c.value, resolveRef), resolve: resolveRef }
      : null;
    return { ...c, idx, type: col.type, ref };
  });
  let rows = table.rows.filter((r) =>
    conds.every((c) => compare(r[c.idx], c, c.type, c.ref)),
  );
  const matched = rows.length;
  if (query.limit !== null) rows = rows.slice(0, query.limit);

  let columns = table.columns.map((c) => c.name);
  if (query.select) {
    const idxs = query.select.map(resolve);
    columns = query.select.map((s, i) => table.columns[idxs[i]].name);
    rows = rows.map((r) => idxs.map((i) => r[i]));
  }
  return { columns, rows, matched, total: table.rows.length };
}
