/**
 * Row diff for a table node: which rows a draft added, changed or removed,
 * matched by the table's `:key` column. Shown in the review screen above the
 * line diff, so a reviewer of a table draft (a view's write-back, or any
 * edit) reads "r1: stage lead → qualified" instead of CSV lines.
 *
 * Null whenever a keyed diff would mislead: no `:key` column, a header that
 * changed, or a key that repeats. The caller then shows the line diff alone.
 * Parsing follows the server's table reader: blank and `#` lines are skipped,
 * cells are trimmed, header directives are `name:key`, `name:number`, …
 */
import { parseDelimited } from "./csv-table";

export interface RowDiff {
  columns: string[];
  keyColumn: string;
  added: Array<{ key: string; values: Record<string, string> }>;
  removed: Array<{ key: string; values: Record<string, string> }>;
  changed: Array<{ key: string; cells: Array<{ column: string; before: string; after: string }> }>;
}

interface Parsed {
  header: string;
  columns: string[];
  keyIdx: number;
  rows: Map<string, string[]>;
}

function parse(body: string): Parsed | null {
  const lines = body.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (lines.length === 0) return null;
  const cellsOf = (line: string) => (parseDelimited(line, ",")[0] ?? []).map((c) => c.trim());
  const rawHeader = cellsOf(lines[0]);
  const columns = rawHeader.map((h) => h.split(":")[0].trim());
  const keyIdx = rawHeader.findIndex((h) => h.split(":").slice(1).some((d) => d.trim().toLowerCase() === "key"));
  if (keyIdx < 0) return null;
  const rows = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const cells = cellsOf(line);
    while (cells.length < columns.length) cells.push("");
    const row = cells.slice(0, columns.length);
    const key = row[keyIdx];
    if (rows.has(key)) return null;
    rows.set(key, row);
  }
  return { header: rawHeader.join(","), columns, keyIdx, rows };
}

export function tableRowDiff(before: string, after: string): RowDiff | null {
  const a = parse(before);
  const b = parse(after);
  if (!a || !b || a.header !== b.header) return null;
  const valuesOf = (row: string[]) => Object.fromEntries(a.columns.map((c, i) => [c, row[i]]));
  const out: RowDiff = { columns: a.columns, keyColumn: a.columns[a.keyIdx], added: [], removed: [], changed: [] };
  for (const [key, row] of b.rows) {
    const old = a.rows.get(key);
    if (!old) {
      out.added.push({ key, values: valuesOf(row) });
      continue;
    }
    const cells = a.columns
      .map((column, i) => ({ column, before: old[i], after: row[i] }))
      .filter((c) => c.before !== c.after);
    if (cells.length) out.changed.push({ key, cells });
  }
  for (const [key, row] of a.rows) if (!b.rows.has(key)) out.removed.push({ key, values: valuesOf(row) });
  return out;
}

const fields = (v: Record<string, string>) =>
  Object.entries(v)
    .map(([k, x]) => `${k}=${x}`)
    .join(", ");

/** One readable line per row: `+` added, `~` changed, `-` removed. */
export function rowDiffLines(d: RowDiff): string[] {
  const lines = [
    ...d.added.map((r) => `+ ${r.key}: ${fields(r.values)}`),
    ...d.changed.map((r) => `~ ${r.key}: ${r.cells.map((c) => `${c.column}: ${c.before} → ${c.after}`).join("; ")}`),
    ...d.removed.map((r) => `- ${r.key}: ${fields(r.values)}`),
  ];
  return lines.length ? lines : ["No row changes."];
}
