/**
 * Row operations on a table node's CSV body — the pure half of
 * `POST /nests/:nestId/nodes/:nodeId/rows`.
 *
 *   { op: "append", row: { col: value, … } }
 *   { op: "update", key, set: { col: value, … } }
 *   { op: "delete", key }
 *
 * Rules:
 *  - Values are validated against the header (`parseTable` in service.ts is
 *    the one reading of it): `:number` must be a finite number, `:date` must
 *    parse, unknown columns are refused, and a value may not hold a line
 *    break (a table row is one line).
 *  - `key` names a row by the table's first `:key` column. update/delete need
 *    one; a key that matches no row, or more than one stored row, is refused.
 *    An append must carry the key and it must be new. The key itself cannot be
 *    changed by `update` (delete + append says that plainly).
 *  - All-or-nothing: ops apply in order to a copy; the first refusal throws a
 *    ValidationError and nothing is returned to write.
 *  - Minimal edits: only the lines of rows an op touched are rewritten, so
 *    comments, blank lines and the quoting of every other row stay
 *    byte-for-byte. The review diff then shows exactly the rows that changed.
 *
 * Kept apart from service.ts on purpose: this module only consumes
 * `parseTable`, so the parser and query grammar stay one file's concern.
 */
import { ValidationError } from "../shared/errors.js";
import { parseTable, type Column } from "./service.js";

export const ROW_OPS_CAPS = {
  /** Ops per request. A view's write bridge enforces the same number. */
  MAX_OPS: 100,
  /** Characters per cell value. */
  MAX_VALUE_CHARS: 10_000,
} as const;

type Value = string;
export type RowOp =
  | { op: "append"; row: Record<string, Value> }
  | { op: "update"; key: Value; set: Record<string, Value> }
  | { op: "delete"; key: Value };

export interface RowOpsResult {
  body: string;
  appended: number;
  updated: number;
  deleted: number;
  /** False when every op left the body as it was. */
  changed: boolean;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function scalar(v: unknown, where: string): Value {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  throw new ValidationError(`${where} must be a string, number, boolean or null`);
}

function cells(v: unknown, where: string): Record<string, Value> {
  if (!isPlainObject(v)) throw new ValidationError(`${where} must be an object of column → value`);
  // Null prototype: a "__proto__" key is a (refused, unknown) column, not a prototype.
  const out: Record<string, Value> = Object.create(null);
  for (const [k, raw] of Object.entries(v)) out[k] = scalar(raw, `${where}.${k}`);
  return out;
}

/** Validate the request's `ops` shape. Column/type checks need the table and
 *  happen in applyRowOps. */
export function parseRowOps(input: unknown): RowOp[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ValidationError("ops must be a non-empty array of {op:'append'|'update'|'delete', …}");
  }
  if (input.length > ROW_OPS_CAPS.MAX_OPS) {
    throw new ValidationError(`ops may hold at most ${ROW_OPS_CAPS.MAX_OPS} operations per request`);
  }
  return input.map((raw, i): RowOp => {
    const at = `ops[${i}]`;
    if (!isPlainObject(raw)) throw new ValidationError(`${at} must be an object`);
    switch (raw.op) {
      case "append":
        return { op: "append", row: cells(raw.row, `${at}.row`) };
      case "update": {
        const set = cells(raw.set, `${at}.set`);
        if (Object.keys(set).length === 0) throw new ValidationError(`${at}.set names no column`);
        return { op: "update", key: requireKey(raw.key, at), set };
      }
      case "delete":
        return { op: "delete", key: requireKey(raw.key, at) };
      default:
        throw new ValidationError(`${at}.op must be "append", "update" or "delete"`);
    }
  });
}

function requireKey(v: unknown, at: string): Value {
  if (typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v))) {
    throw new ValidationError(`${at}.key must be a string or number`);
  }
  const key = String(v).trim();
  if (!key) throw new ValidationError(`${at}.key is empty`);
  return key;
}

/** Plain decimal (optionally signed, with exponent): no hex, no Infinity. */
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
/** An ISO date, optionally with a time — what WHERE compares as a date. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** ISO shape, parseable, and a real calendar day (Date.parse rolls
 *  2024-02-30 over to March 1 instead of failing). */
function isRealDate(v: string): boolean {
  if (!ISO_DATE_RE.test(v) || Number.isNaN(Date.parse(v))) return false;
  const [y, m, d] = v.slice(0, 10).split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
}

function checkValue(col: Column, value: Value, at: string): void {
  if (/[\r\n]/.test(value)) throw new ValidationError(`${at}: "${col.name}" may not contain a line break`);
  if (value.length > ROW_OPS_CAPS.MAX_VALUE_CHARS) {
    throw new ValidationError(`${at}: "${col.name}" is longer than ${ROW_OPS_CAPS.MAX_VALUE_CHARS} characters`);
  }
  if (value === "") return;
  if (col.type === "number" && !(NUMBER_RE.test(value) && Number.isFinite(Number(value)))) {
    throw new ValidationError(`${at}: "${col.name}" is a :number column, and "${value}" is not a number`);
  }
  if (col.type === "date" && !isRealDate(value)) {
    throw new ValidationError(`${at}: "${col.name}" is a :date column, and "${value}" is not a date`);
  }
}

/** One CSV cell, quoted only when it has to be (and a leading `#` on the
 *  first cell, which the parser would otherwise read as a comment line). */
function csvCell(v: Value, first: boolean): string {
  if (/[",]/.test(v) || (first && v.startsWith("#"))) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

const csvLine = (values: Value[]) => values.map((v, i) => csvCell(v, i === 0)).join(",");

/** Every cell of one data line, including any past the header (the table
 *  parser drops those; a rewrite must keep them). Trailing empty extras are
 *  dropped — they carry nothing and may be padding. */
function extraCells(line: string, width: number): Value[] {
  const wide = Math.max(width, line.split(",").length);
  const header = Array.from({ length: wide }, (_, i) => `c${i}`).join(",");
  const all = parseTable(`${header}\n${line}`).rows[0] ?? [];
  const extra = all.slice(width);
  while (extra.length && extra[extra.length - 1] === "") extra.pop();
  return extra;
}

const isContentLine = (l: string) => l.trim() !== "" && !l.trim().startsWith("#");

export function applyRowOps(body: string, ops: RowOp[]): RowOpsResult {
  const { columns, rows: parsedRows } = parseTable(body);
  const byName = new Map(columns.map((c, i) => [c.name, i]));
  if (byName.size !== columns.length) {
    throw new ValidationError("the table header names a column more than once; fix the header before writing rows");
  }
  const keyIdx = columns.findIndex((c) => c.key);
  const keyName = keyIdx >= 0 ? columns[keyIdx].name : null;

  // Work on lines so untouched ones are kept exactly, each with its own line
  // ending. `null` marks a deleted line; data rows hold their parsed cells.
  const pieces = body.split(/(\r?\n)/);
  const lines: Array<string | null> = pieces.filter((_, i) => i % 2 === 0);
  const ends: string[] = pieces.filter((_, i) => i % 2 === 1);
  const crlf = ends.filter((e) => e === "\r\n").length;
  const eol = crlf > ends.length - crlf ? "\r\n" : "\n";
  const headerAt = lines.findIndex((l) => l !== null && isContentLine(l));
  type Row = { line: number; values: Value[]; dirty: boolean };
  const rows: Row[] = [];
  // parseTable already parsed the data rows, in this same line order (same
  // content-line rule), so zip them with their line numbers.
  for (let i = headerAt + 1, r = 0; i < lines.length; i++) {
    if (isContentLine(lines[i] as string)) rows.push({ line: i, values: [...parsedRows[r++]], dirty: false });
  }
  const appended: Value[][] = [];
  let nAppend = 0;
  let nUpdate = 0;
  let nDelete = 0;
  let changed = false;

  const resolveColumns = (vals: Record<string, Value>, at: string) => {
    for (const [name, v] of Object.entries(vals)) {
      const idx = byName.get(name);
      if (idx === undefined) {
        throw new ValidationError(`${at}: unknown column "${name}" — table has: ${columns.map((c) => c.name).join(", ")}`);
      }
      checkValue(columns[idx], v, at);
    }
  };
  const liveKeys = () => [
    ...rows.filter((r) => lines[r.line] !== null).map((r) => r.values[keyIdx]),
    ...appended.map((r) => r[keyIdx]),
  ];
  const findOne = (key: Value, at: string): { values: Value[]; row?: Row } => {
    if (keyIdx < 0) throw new ValidationError(`${at}: this table has no :key column, so rows can't be addressed by key`);
    const hits: Array<{ values: Value[]; row?: Row }> = [
      ...rows.filter((r) => lines[r.line] !== null && r.values[keyIdx] === key).map((r) => ({ values: r.values, row: r })),
      ...appended.filter((r) => r[keyIdx] === key).map((values) => ({ values })),
    ];
    if (hits.length === 0) throw new ValidationError(`${at}: no row with ${keyName} = "${key}"`);
    if (hits.length > 1) {
      throw new ValidationError(`${at}: more than one row has ${keyName} = "${key}"; fix the table before writing by key`);
    }
    return hits[0];
  };

  ops.forEach((op, i) => {
    const at = `ops[${i}]`;
    if (op.op === "append") {
      resolveColumns(op.row, at);
      // Own properties only: a column named "constructor" must not read
      // Object.prototype's.
      const values = columns.map((c) => (Object.hasOwn(op.row, c.name) ? op.row[c.name] : ""));
      if (keyIdx >= 0) {
        const key = values[keyIdx];
        if (!key) throw new ValidationError(`${at}: an appended row needs its key column "${keyName}"`);
        if (liveKeys().includes(key)) throw new ValidationError(`${at}: a row with ${keyName} = "${key}" already exists`);
      }
      if (values.every((v) => v === "")) throw new ValidationError(`${at}: an appended row needs at least one value`);
      appended.push(values);
      nAppend++;
      changed = true;
    } else if (op.op === "update") {
      resolveColumns(op.set, at);
      const hit = findOne(op.key, at);
      let touched = false;
      for (const [name, v] of Object.entries(op.set)) {
        const idx = byName.get(name)!;
        if (idx === keyIdx && v !== hit.values[idx]) {
          throw new ValidationError(`${at}: the key column "${keyName}" can't be changed — delete the row and append it instead`);
        }
        if (hit.values[idx] !== v) {
          hit.values[idx] = v;
          if (hit.row) hit.row.dirty = true;
          changed = touched = true;
        }
      }
      // Count only rows a value actually changed in.
      if (touched) nUpdate++;
    } else {
      const hit = findOne(op.key, at);
      if (hit.row) lines[hit.row.line] = null;
      else appended.splice(appended.indexOf(hit.values), 1);
      nDelete++;
      changed = true;
    }
  });

  if (!changed) return { body, appended: nAppend, updated: nUpdate, deleted: nDelete, changed: false };

  for (const r of rows) {
    if (r.dirty && lines[r.line] !== null) {
      lines[r.line] = csvLine([...r.values, ...extraCells(lines[r.line] as string, columns.length)]);
    }
  }
  // Each kept line with the ending that followed it (the last has none).
  const kept: Array<{ text: string; end: string }> = [];
  lines.forEach((text, i) => {
    if (text !== null) kept.push({ text, end: ends[i] ?? "" });
  });
  // Appends go after the last content line, keeping any trailing blank lines
  // (a body ending in a newline still ends in one).
  let lastContent = kept.length - 1;
  while (lastContent > 0 && !isContentLine(kept[lastContent].text)) lastContent--;
  if (appended.length) {
    const before = kept[lastContent];
    const tailEnd = before.end;
    before.end = before.end || eol;
    const added = appended.map((v, i) => ({ text: csvLine(v), end: i === appended.length - 1 ? tailEnd : eol }));
    kept.splice(lastContent + 1, 0, ...added);
  }
  // A deleted last line leaves the new last line's ending dangling.
  if (kept.length && lines[lines.length - 1] === null) kept[kept.length - 1].end = "";
  return {
    body: kept.map((k) => k.text + k.end).join(""),
    appended: nAppend,
    updated: nUpdate,
    deleted: nDelete,
    changed: true,
  };
}
