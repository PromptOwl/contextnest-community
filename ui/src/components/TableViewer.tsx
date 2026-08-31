import { useMemo, useState } from "react";
import { Table2, Play } from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import * as api from "../lib/api";

/**
 * Read view for TABLE nodes — the CSV rendered as a grid, plus an inline
 * query box that runs the SAME deterministic /table-query an agent would,
 * so authors can test lookups where the data lives.
 *
 * Client parse is display-only (simple split honoring quotes); the query box
 * round-trips through the server so what you test is what agents get.
 */

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function TableViewer({
  nestId,
  nodeId,
  csv,
}: {
  nestId: string;
  nodeId: string;
  csv: string;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{
    columns: string[];
    rows: string[][];
    matched: number;
    returned: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const parsed = useMemo(() => {
    const lines = csv
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    if (!lines.length) return { header: [] as string[], rows: [] as string[][] };
    const header = splitCsvLine(lines[0]);
    const rows = lines.slice(1).map(splitCsvLine);
    return { header, rows };
  }, [csv]);

  const runLookup = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await api.tableQuery(nestId, nodeId, query));
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Query failed");
    } finally {
      setRunning(false);
    }
  };

  const shown = result ?? {
    columns: parsed.header.map((h) => h.split(":")[0]),
    rows: parsed.rows,
    matched: parsed.rows.length,
    returned: parsed.rows.length,
    total: parsed.rows.length,
  };

  return (
    <div className="space-y-3">
      {/* The query box — same grammar agents use via table-query / MCP. */}
      <div className="flex items-center gap-2">
        <Table2 className="h-4 w-4 text-cyan-500 shrink-0" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void runLookup()}
          placeholder='where region = "EU" and price > 100 select sku, price limit 5 — empty = all rows'
          className="h-8 text-xs font-mono flex-1"
          data-testid="table-query-input"
        />
        <Button size="sm" className="h-8" disabled={running} onClick={() => void runLookup()}>
          <Play className="h-3.5 w-3.5 mr-1" /> Query
        </Button>
        {result && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-muted-foreground"
            onClick={() => {
              setResult(null);
              setError(null);
            }}
          >
            Show all
          </Button>
        )}
      </div>
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant="secondary" className="text-[10px]">
          {shown.returned} row{shown.returned === 1 ? "" : "s"}
          {result ? ` of ${shown.matched} matching` : ""} · {shown.total} total
        </Badge>
        {/* Directive-annotated headers surface as chips so column semantics
            are visible without opening the editor. */}
        {parsed.header
          .filter((h) => h.includes(":"))
          .map((h) => (
            <Badge key={h} variant="outline" className="text-[10px] font-mono">
              {h}
            </Badge>
          ))}
      </div>
      <TableGrid columns={shown.columns} rows={shown.rows} />
    </div>
  );
}

/**
 * The grid itself — shared with the CSV source editor's live preview so the
 * author sees the same rendering the reader gets.
 */
export function TableGrid({
  columns,
  rows,
  limit = 500,
}: {
  columns: string[];
  rows: string[][];
  limit?: number;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/50 text-left text-muted-foreground">
            {columns.map((h) => (
              <th key={h} className="px-3 py-2 font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r, i) => (
            <tr key={i} className="border-t align-top hover:bg-muted/30">
              {r.map((cell, j) => (
                <td key={j} className="px-3 py-1.5 whitespace-nowrap font-mono">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && (
        <p className="px-3 py-2 text-[11px] text-muted-foreground border-t">
          Showing first {limit.toLocaleString()} rows.
        </p>
      )}
    </div>
  );
}
