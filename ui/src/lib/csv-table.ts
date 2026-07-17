/**
 * csv-table — deterministic CSV/TSV → GitHub-flavored-markdown table.
 *
 * Pure functions, no DOM, no AI. Used by the markdown editor's paste
 * interceptor and the "Insert table from CSV" toolbar action. The output is
 * a plain GFM pipe table, so nothing new is stored — tiptap-markdown parses
 * it into the existing table nodes and `Table.ts` serializes it back.
 *
 * Parsing follows RFC 4180-ish rules:
 *   - fields may be wrapped in double quotes
 *   - `""` inside a quoted field is a literal quote
 *   - delimiters and newlines inside a quoted field are literal
 *   - both `\n` and `\r\n` row endings; a UTF-8 BOM is ignored
 *   - a stray quote inside an unquoted field is literal (lenient)
 */

export type Delimiter = "," | "\t" | ";";

/** Data-row count above which callers should confirm before inserting. */
export const LARGE_TABLE_ROW_THRESHOLD = 500;

/**
 * Split delimited text into rows of raw cell strings.
 * Rows that are entirely empty (blank lines, trailing newline) are dropped.
 */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Skip a UTF-8 BOM (common in Excel CSV exports).
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      // Opening quote only counts at the start of a field; a quote in the
      // middle of an unquoted field is treated as a literal character.
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) endRow();

  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function consistentColumns(rows: string[][]): boolean {
  return rows.length > 0 && rows.every((r) => r.length === rows[0].length);
}

/**
 * Pick the delimiter that yields a coherent grid: every row parses to the
 * same column count, with at least 2 columns. Tab is checked first because
 * spreadsheet clipboards are TSV and cell values often contain commas;
 * then comma, then semicolon (common in European locales).
 */
export function detectDelimiter(text: string): Delimiter | null {
  const candidates: Delimiter[] = ["\t", ",", ";"];
  for (const d of candidates) {
    if (!text.includes(d)) continue;
    const rows = parseDelimited(text, d);
    if (rows.length >= 1 && rows[0].length >= 2 && consistentColumns(rows)) {
      return d;
    }
  }
  return null;
}

// Plain numbers plus the common spreadsheet dressings: sign, thousands
// separators, decimals, currency, percent. "Revenue" fails; "1,204.50" passes.
const NUMERIC_LIKE = /^[+-]?[$€£]?\d[\d,]*(\.\d+)?%?$/;

export function isNumericLike(cell: string): boolean {
  return NUMERIC_LIKE.test(cell.trim());
}

/**
 * Heuristic: does the first row look like a header?
 *
 * Header when the first row is fully populated with non-numeric text AND
 * either (a) some later cell is numeric-like — labels over data — or
 * (b) the data is all-text but the first row's labels are unique.
 * Deterministic; callers can override via `hasHeader`.
 */
export function detectHeaderRow(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  if (first.length === 0) return false;
  if (first.some((c) => c.trim() === "")) return false;
  if (first.some(isNumericLike)) return false;
  const rest = rows.slice(1);
  if (rest.some((r) => r.some(isNumericLike))) return true;
  const labels = new Set(first.map((c) => c.trim().toLowerCase()));
  return labels.size === first.length;
}

/**
 * Make a cell safe inside a GFM pipe table: escape backslashes then pipes
 * (same order as the editor's table serializer), and collapse in-cell
 * newlines to `<br>` — GFM cells cannot contain raw line breaks.
 */
function escapeCell(cell: string): string {
  return cell
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

/**
 * Rows → GFM markdown table string (no trailing newline).
 *
 * GFM requires a header row: when `hasHeader` is false (or the heuristic
 * says the first row is data), synthetic `Column N` headers are generated
 * and every input row becomes a data row. Ragged rows are padded with empty
 * cells to the widest row.
 */
export function rowsToMarkdownTable(
  rows: string[][],
  opts: { hasHeader?: boolean } = {},
): string {
  if (rows.length === 0) return "";
  // reduce, not Math.max(...spread): spreading one argument per row can
  // overflow the call stack on very large inputs (the row-count confirm is
  // a warning, not a cap).
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  if (width === 0) return "";
  const grid = rows.map((r) => {
    const cells = r.map(escapeCell);
    while (cells.length < width) cells.push("");
    return cells;
  });
  const hasHeader = opts.hasHeader ?? detectHeaderRow(rows);
  const header = hasHeader
    ? grid[0]
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const body = hasHeader ? grid.slice(1) : grid;
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
  return [line(header), separator, ...body.map(line)].join("\n");
}

/** RFC-4180 cell quoting: wrap when the cell carries a comma, quote, or newline. */
function csvEscapeCell(cell: string): string {
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/**
 * Rows → canonical comma-CSV (no trailing newline). Used by the table-node
 * source editor to normalize TSV/semicolon grids (spreadsheet clipboards,
 * European exports) into the body format the server's table parser and
 * /table-query read.
 */
export function rowsToCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvEscapeCell).join(",")).join("\n");
}

export interface DetectedTable {
  delimiter: Delimiter;
  rows: string[][];
}

// A pasted "cell" longer than this reads as prose, not tabular data.
const MAX_DETECTED_CELL_LENGTH = 200;

/**
 * Conservative paste detection: is this plain text almost certainly a table?
 *
 * TSV (contains tabs): ≥2 rows, ≥2 columns, every row the same width —
 * tab-delimited multi-row text is a strong spreadsheet-clipboard signal.
 * CSV / semicolon-SV (no tabs): those delimiters appear constantly in
 * prose, so the bar is higher — ≥3 rows, ≥2 columns, consistent width, and
 * no cell long enough to read as a sentence. Comma is tried before
 * semicolon (mirroring detectDelimiter's order). Anything ambiguous returns
 * null so the paste falls through to the editor's default plain-text
 * handling.
 */
export function looksLikeDelimitedTable(text: string): DetectedTable | null {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed || !trimmed.includes("\n")) return null;

  if (trimmed.includes("\t")) {
    const rows = parseDelimited(trimmed, "\t");
    if (rows.length >= 2 && rows[0].length >= 2 && consistentColumns(rows)) {
      return { delimiter: "\t", rows };
    }
    return null;
  }

  const proseyDelimiters: Delimiter[] = [",", ";"];
  for (const delimiter of proseyDelimiters) {
    if (!trimmed.includes(delimiter)) continue;
    const rows = parseDelimited(trimmed, delimiter);
    if (
      rows.length >= 3 &&
      rows[0].length >= 2 &&
      consistentColumns(rows) &&
      rows.every((r) => r.every((c) => c.length <= MAX_DETECTED_CELL_LENGTH))
    ) {
      return { delimiter, rows };
    }
  }
  return null;
}

/**
 * Single-ROW variant of the paste detection: is this one line (no newline)
 * a tab- or semicolon-delimited grid row? Copying a single row from a
 * spreadsheet yields exactly this (`A\tB\tC`, no trailing newline), which
 * `looksLikeDelimitedTable` deliberately rejects (it requires ≥2 rows) —
 * without this check the literal tabs would land inside one comma-cell.
 *
 * Tab: ≥2 cells is a strong spreadsheet signal. Semicolon: appears in
 * prose, so additionally no cell may read as a sentence (same length cap
 * as the multi-row heuristic). Comma lines are already canonical CSV and
 * are never matched.
 */
export function looksLikeDelimitedRow(text: string): DetectedTable | null {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) return null;

  if (trimmed.includes("\t")) {
    const rows = parseDelimited(trimmed, "\t");
    if (rows.length === 1 && rows[0].length >= 2) {
      return { delimiter: "\t", rows };
    }
    return null;
  }

  if (trimmed.includes(";") && !trimmed.includes(",")) {
    const rows = parseDelimited(trimmed, ";");
    if (
      rows.length === 1 &&
      rows[0].length >= 2 &&
      rows[0].every((c) => c.length <= MAX_DETECTED_CELL_LENGTH)
    ) {
      return { delimiter: ";", rows };
    }
  }
  return null;
}

export interface ConvertedTable {
  markdown: string;
  /** Rows below the header (what actually renders as table body). */
  dataRows: number;
  hasHeader: boolean;
}

/**
 * One-call conversion for the file-upload path: detect (or accept) a
 * delimiter, parse, detect (or accept) a header row, emit markdown.
 * Returns null when no rows survive parsing.
 */
export function delimitedToMarkdownTable(
  text: string,
  opts: { delimiter?: Delimiter; hasHeader?: boolean } = {},
): ConvertedTable | null {
  // Single-column files have no delimiter to detect; comma is a harmless
  // fallback (no commas → one cell per line).
  const delimiter = opts.delimiter ?? detectDelimiter(text) ?? ",";
  const rows = parseDelimited(text, delimiter);
  if (rows.length === 0) return null;
  const hasHeader = opts.hasHeader ?? detectHeaderRow(rows);
  return {
    markdown: rowsToMarkdownTable(rows, { hasHeader }),
    dataRows: rows.length - (hasHeader ? 1 : 0),
    hasHeader,
  };
}
