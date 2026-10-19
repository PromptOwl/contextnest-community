import { useMemo, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent } from "react";
import { AlertTriangle, Plus, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  editCsvTable,
  looksLikeDelimitedRow,
  looksLikeDelimitedTable,
  parseDelimited,
  readUploadedTable,
  rowsToCsv,
  tableTypeIssueMessage,
  typedColumnIssues,
  uploadedTableErrorMessage,
} from "../lib/csv-table";
import type { CsvTableEdit } from "../lib/csv-table";
import { TableGrid } from "./TableViewer";

/**
 * Source editor for TABLE nodes — a monospace textarea over the node's
 * canonical body format (raw CSV: header row + data rows, optional
 * `:key/:number/:date` directives and `#` comment lines), with the CSV
 * affordances a fact store wants:
 *
 *   - "Replace from CSV / TSV" file upload. A table node's body IS the
 *     table, so the semantics are replace-content, not insert-into-doc.
 *     Comma files are kept byte-for-byte (preserves quoting, directives,
 *     comments); TSV/semicolon files are re-serialized to canonical CSV.
 *   - Paste of a tab/semicolon grid (spreadsheet clipboards) converts to
 *     CSV and replaces the body — pasting raw TSV into a CSV body would
 *     corrupt the store. Comma pastes are already canonical, so they paste
 *     normally at the caret (row-level editing stays possible).
 *
 * Both replace paths offer a one-click Undo via toast. No TipTap, no
 * markdown round-trip: the string in this textarea is byte-for-byte what
 * the server's table parser and /table-query will read.
 */

export interface TableSourceEditorProps {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  readOnly?: boolean;
}

export function TableSourceEditor({
  value,
  onChange,
  onBlur,
  readOnly = false,
}: TableSourceEditorProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  // Upload does a real amount of async waiting (rAF yields, file.text(),
  // parsing) before it overwrites the body with a value closed over at
  // click-time — lock the textarea for that window so concurrent typing
  // isn't silently discarded when the upload resolves.
  const [uploading, setUploading] = useState(false);
  const locked = readOnly || uploading;

  // Live grid under the source: CSV is hard to proofread as text, and the
  // reader sees a table. Comment lines and header directives are stripped the
  // same way the read view strips them.
  // Rows of empty cells are kept so a row just added in the grid stays visible
  // until it is filled in.
  const preview = useMemo(() => {
    const rows = parseDelimited(value, ",", true).filter(
      (r) => !(r[0] ?? "").trimStart().startsWith("#"),
    );
    return {
      header: rows[0] ?? [],
      columns: (rows[0] ?? []).map((h) => h.split(":")[0].trim()),
      rows: rows.slice(1),
      // A preview that renders bad data as if it were fine is what made the
      // typed header look enforced when nothing checked it.
      issues: typedColumnIssues(rows),
    };
  }, [value]);

  const applyEdit = (edit: CsvTableEdit) => {
    if (locked) return;
    onChange(editCsvTable(value, edit));
  };

  const replaceWith = (next: string, summary: string) => {
    const prev = value;
    onChange(next);
    toast(
      summary,
      prev.trim()
        ? { action: { label: "Undo", onClick: () => onChange(prev) } }
        : undefined,
    );
  };

  const onFilePicked = async (e: ChangeEvent<HTMLInputElement>) => {
    if (locked) return; // defense independent of the button's disabled
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setUploading(true);
    try {
      const toastId = toast.loading("Processing file…");
      // Let the loader actually paint before the (synchronous, possibly heavy)
      // read + parse blocks the main thread — two frames clears the commit+paint.
      // Table CSVs are plausibly the largest uploads in the app.
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
      );
      // Size cap, read, delimiter resolution, parse — shared with the
      // markdown editor's table import (csv-table.readUploadedTable).
      const res = await readUploadedTable(file);
      if (!res.ok) {
        toast.error(uploadedTableErrorMessage(res.error, file), { id: toastId });
        return;
      }
      // Comma files are already the canonical body format — keep them
      // verbatim so quoting, `#` comments, and header directives survive.
      const next = res.delimiter === "," ? res.text : rowsToCsv(res.rows);
      // Toast counts DATA rows only: skip `#` comment lines (the server's
      // table parser ignores them) and the header row.
      const dataRows = Math.max(
        0,
        res.rows.filter((r) => !(r[0] ?? "").trimStart().startsWith("#")).length -
          1,
      );
      // replaceWith pops its own result toast; drop the loader first.
      toast.dismiss(toastId);
      replaceWith(
        next,
        `Table replaced from ${file.name} — ${dataRows.toLocaleString()} data row${dataRows === 1 ? "" : "s"}.`,
      );
    } finally {
      setUploading(false);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (locked) return;
    const text = e.clipboardData.getData("text/plain");

    // Multi-row tab/semicolon grid → convert + replace the whole body (a
    // table node's body is one grid). Comma pastes are already canonical
    // CSV — default caret paste applies.
    const detected = looksLikeDelimitedTable(text);
    if (detected && detected.delimiter !== ",") {
      e.preventDefault();
      replaceWith(
        rowsToCsv(detected.rows),
        `Pasted grid converted to CSV — table body replaced (${detected.rows.length.toLocaleString()} rows).`,
      );
      return;
    }
    if (detected) return;

    // Single spreadsheet ROW (`A\tB\tC`, no newline — looksLikeDelimitedTable
    // requires ≥2 rows) → convert to one CSV line and INSERT at the caret:
    // one row is an edit within the grid, not a new grid, and letting the
    // default paste through would land literal tabs inside one comma-cell.
    const row = looksLikeDelimitedRow(text);
    if (!row) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const inserted = rowsToCsv(row.rows);
    onChange(value.slice(0, start) + inserted + value.slice(end));
    // Restore the caret after React re-renders the controlled value.
    const caret = start + inserted.length;
    requestAnimationFrame(() => el.setSelectionRange(caret, caret));
  };

  return (
    <div data-testid="table-source-editor">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground min-w-0">
          CSV — header first; directives welcome (
          <code>sku:key, price:number</code>). Pasting a spreadsheet/TSV grid
          converts it to CSV.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0"
          disabled={locked}
          onClick={() => fileRef.current?.click()}
          data-testid="table-source-upload"
        >
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          Replace from CSV / TSV
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,text/csv,text/tab-separated-values"
          className="hidden"
          onChange={onFilePicked}
        />
      </div>
      {/* Source and grid sit side by side once there is something to render:
          proofreading CSV means comparing the two, and stacking them put a
          large table's source off-screen from its result. */}
      <div className={preview.columns.length > 0 ? "grid gap-3 lg:grid-cols-2" : ""}>
        <textarea
          value={value}
          onChange={(e) => {
            if (locked) return;
            onChange(e.target.value);
          }}
          onBlur={onBlur}
          onPaste={onPaste}
          readOnly={locked}
          spellCheck={false}
          placeholder={"sku:key, price:number, region\nOWL-100, 149, EU"}
          className="w-full min-h-[360px] border rounded-lg bg-background shadow-sm p-4 font-mono text-sm leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-ring"
          data-testid="table-source-textarea"
        />
        {preview.columns.length > 0 && (
          <div className="min-w-0" data-testid="table-source-preview">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Preview — {preview.rows.length.toLocaleString()} data row
              {preview.rows.length === 1 ? "" : "s"}
            </p>
            {preview.issues.length > 0 && (
              <div
                className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
                data-testid="table-source-issues"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0">
                    <b>
                      {preview.issues.length} column
                      {preview.issues.length === 1 ? "" : "s"} disagree with the
                      header
                    </b>{" "}
                    — table-query trusts these types.
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {preview.issues.slice(0, 5).map((issue, i) => (
                        <li key={`${issue.column}-${issue.kind}-${i}`}>
                          {tableTypeIssueMessage(issue)}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
            {locked ? (
              <TableGrid columns={preview.columns} rows={preview.rows} limit={50} />
            ) : (
              <EditableGrid header={preview.header} rows={preview.rows} onEdit={applyEdit} />
            )}
          </div>
        )}
      </div>
      {preview.columns.length === 0 && !locked && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 h-7"
          onClick={() => applyEdit({ op: "add-column" })}
          data-testid="table-grid-add-column"
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add column
        </Button>
      )}
    </div>
  );
}

const GRID_ROW_LIMIT = 50;

/**
 * The preview grid as an editor: cells edit in place (committed on blur or
 * Enter), and rows/columns are added at the end or removed from their ×.
 * Long tables show the first rows plus the last one, so an added row is
 * always on screen to fill in.
 */
function EditableGrid({
  header,
  rows,
  onEdit,
}: {
  header: string[];
  rows: string[][];
  onEdit: (edit: CsvTableEdit) => void;
}) {
  const shown = rows.slice(0, GRID_ROW_LIMIT).map((r, i) => ({ r, i }));
  const hidden = rows.length - GRID_ROW_LIMIT;
  if (hidden > 0) shown.push({ r: rows[rows.length - 1], i: rows.length - 1 });

  const cell = (row: number, col: number, text: string, isHeader = false) => (
    <input
      // Keyed on the text so an edit made in the CSV source re-seeds the cell.
      key={`${row}:${col}:${text}`}
      defaultValue={text}
      aria-label={isHeader ? `Column ${col + 1} header` : `Row ${row + 1}, column ${col + 1}`}
      onBlur={(e) => {
        if (e.target.value !== text) onEdit({ op: "set-cell", row, col, value: e.target.value });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className={`w-full min-w-24 bg-transparent px-2 py-1 font-mono focus:outline-none focus:ring-1 focus:ring-ring rounded-sm ${isHeader ? "font-semibold" : ""}`}
    />
  );

  return (
    <div className="space-y-2" data-testid="table-grid-editor">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/50 text-left text-muted-foreground">
              {header.map((h, j) => (
                <th key={j} className="p-1 align-top">
                  <div className="flex items-center">
                    {cell(-1, j, h, true)}
                    <button
                      type="button"
                      title="Delete column"
                      onClick={() => onEdit({ op: "delete-column", col: j })}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      data-testid={`table-grid-delete-column-${j}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </th>
              ))}
              <th className="w-6" />
            </tr>
          </thead>
          <tbody>
            {shown.map(({ r, i }) => (
              <tr key={i} className="border-t">
                {header.map((_, j) => (
                  <td key={j} className="p-1">
                    {cell(i, j, r[j] ?? "")}
                  </td>
                ))}
                <td className="w-6 p-1">
                  <button
                    type="button"
                    title="Delete row"
                    onClick={() => onEdit({ op: "delete-row", row: i })}
                    className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    data-testid={`table-grid-delete-row-${i}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {hidden > 1 && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground border-t">
            {(hidden - 1).toLocaleString()} more rows between row {GRID_ROW_LIMIT} and the last
            row — edit them in the CSV source.
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => onEdit({ op: "add-row" })}
          data-testid="table-grid-add-row"
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add row
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => onEdit({ op: "add-column" })}
          data-testid="table-grid-add-column"
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add column
        </Button>
      </div>
    </div>
  );
}
