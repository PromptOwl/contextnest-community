import { useRef } from "react";
import type { ChangeEvent, ClipboardEvent } from "react";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  looksLikeDelimitedRow,
  looksLikeDelimitedTable,
  readUploadedTable,
  rowsToCsv,
  uploadedTableErrorMessage,
} from "../lib/csv-table";

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
    if (readOnly) return; // defense independent of the button's disabled
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
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
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (readOnly) return;
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
          disabled={readOnly}
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
      <textarea
        value={value}
        onChange={(e) => {
          if (readOnly) return;
          onChange(e.target.value);
        }}
        onBlur={onBlur}
        onPaste={onPaste}
        readOnly={readOnly}
        spellCheck={false}
        placeholder={"sku:key, price:number, region\nOWL-100, 149, EU"}
        className="w-full min-h-[360px] border rounded-lg bg-background shadow-sm p-4 font-mono text-sm leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-ring"
        data-testid="table-source-textarea"
      />
    </div>
  );
}
