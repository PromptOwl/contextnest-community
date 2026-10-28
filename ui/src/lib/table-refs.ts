/**
 * Table `:ref` cells, client side — mirrors parseTable / parseRefTarget /
 * extractTableRefs in src/tables/service.ts (keep the two in step). Used by
 * the backlinks panel to show "Pipeline · account · r1" on the target doc.
 *
 * Lenient where the server is strict: a body that wouldn't parse (unknown
 * directive, empty header) yields no refs instead of throwing, since the
 * panel is best-effort and the doc still lists as a plain wikilink backlink.
 */

export interface TableRef {
  column: string;
  /** The row's `:key` value, or `row N` (1-based) when it has none. */
  row: string;
  target: string;
}

const DIRECTIVES = new Set(["key", "number", "date", "text", "ref"]);
const REF_CELL_RE = /^\[\[([^\]|]*)(?:\|[^\]]*)?\]\]$/;

/** Same splitter as the server: quoted cells, doubled-quote escapes, trimmed. */
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

/** The target a ref cell names, or null for a blank cell. */
export function parseRefTarget(cell: string): string | null {
  const v = (cell ?? "").trim();
  if (!v) return null;
  const m = REF_CELL_RE.exec(v);
  const target = (m ? m[1] : v).trim();
  return target || null;
}

/** Every non-empty ref cell of a table body, in row then column order. */
export function extractTableRefs(body: string): TableRef[] {
  const lines = (body ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (!lines.length) return [];
  const cols: Array<{ name: string; key: boolean; ref: boolean }> = [];
  for (const raw of splitCsvLine(lines[0])) {
    const parts = raw.split(":").map((p) => p.trim());
    if (!parts[0]) return [];
    let key = false;
    let ref = false;
    for (const d of parts.slice(1)) {
      const dl = d.toLowerCase();
      if (!DIRECTIVES.has(dl)) return [];
      if (dl === "key") key = true;
      else if (dl === "ref") ref = true;
    }
    cols.push({ name: parts[0], key, ref });
  }
  const refIdx = cols.map((c, i) => (c.ref ? i : -1)).filter((i) => i >= 0);
  if (!refIdx.length) return [];
  const keyIdx = cols.findIndex((c) => c.key);
  const out: TableRef[] = [];
  lines.slice(1).forEach((l, n) => {
    const cells = splitCsvLine(l);
    const key = keyIdx >= 0 ? (cells[keyIdx] ?? "").trim() : "";
    const row = key || `row ${n + 1}`;
    for (const i of refIdx) {
      const target = parseRefTarget(cells[i] ?? "");
      if (target) out.push({ column: cols[i].name, row, target });
    }
  });
  return out;
}
