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

const DIRECTIVES = new Set(["key", "number", "date", "text"]);

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
    for (const d of parts.slice(1)) {
      const dl = d.toLowerCase();
      if (!DIRECTIVES.has(dl)) {
        throw new ValidationError(
          `unknown column directive ":${d}" on "${name}" — known: ${[...DIRECTIVES].join(", ")}`,
        );
      }
      if (dl === "key") key = true;
      else type = dl as ColumnType;
    }
    return { name, type, key };
  });

  const rows = lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    // Ragged rows pad/truncate to the header width — data entry is human.
    while (cells.length < columns.length) cells.push("");
    return cells.slice(0, columns.length);
  });
  return { columns, rows };
}

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

function compare(cell: string, cond: Condition, type: ColumnType): boolean {
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

/** Evaluate a query against a parsed table. Row order is source order —
 *  stable by construction, which is what makes results replayable. */
export function runQuery(table: ParsedTable, query: TableQuery): QueryResult {
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

  const conds = query.where.map((c) => ({
    ...c,
    idx: resolve(c.column),
    type: table.columns[resolve(c.column)].type,
  }));
  let rows = table.rows.filter((r) =>
    conds.every((c) => compare(r[c.idx], c, c.type)),
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
