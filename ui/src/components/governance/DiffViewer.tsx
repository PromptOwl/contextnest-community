/**
 * DiffViewer — renders a unified patch GitHub-style: per-line old/new line
 * numbers, a +/- sign gutter, and clear add/delete row backgrounds.
 *
 * Dependency-free; parses the unified hunk headers (@@ -a,b +c,d @@) to track
 * line numbers so additions/deletions read line-by-line like a code review.
 */
import { cn } from "@/lib/utils";

interface DiffViewerProps {
  patch: string;
  className?: string;
}

type Row = {
  kind: "add" | "del" | "ctx" | "hunk" | "file";
  oldNo: number | null;
  newNo: number | null;
  text: string;
};

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  // @@ -oldStart,oldLen +newStart,newLen @@
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

function toRows(patch: string): Row[] {
  const lines = patch.split(/\r?\n/);
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      rows.push({ kind: "file", oldNo: null, newNo: null, text: line });
      continue;
    }
    const hunk = parseHunkHeader(line);
    if (hunk) {
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else {
      // context (leading space) or blank tail line
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return rows;
}

const ROW_BG: Record<Row["kind"], string> = {
  add: "bg-green-100 dark:bg-green-950/50",
  del: "bg-red-100 dark:bg-red-950/50",
  ctx: "",
  hunk: "bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300",
  file: "bg-muted text-muted-foreground font-semibold",
};

const SIGN: Record<Row["kind"], string> = {
  add: "+",
  del: "-",
  ctx: " ",
  hunk: "",
  file: "",
};

const GUTTER_CELL =
  "select-none w-10 shrink-0 px-1 text-right tabular-nums text-[10px] text-muted-foreground/70 border-r border-border/60";

export function DiffViewer({ patch, className }: DiffViewerProps) {
  const rows = toRows(patch);

  return (
    <div
      className={cn(
        "rounded-md border bg-background font-mono text-xs leading-relaxed overflow-x-auto max-h-96",
        className,
      )}
      data-testid="diff-viewer"
    >
      {rows.map((r, i) => {
        // Hunk + file headers span the full width without line-number gutters.
        if (r.kind === "hunk" || r.kind === "file") {
          return (
            <div key={i} className={cn("px-3 whitespace-pre", ROW_BG[r.kind])}>
              {r.text || " "}
            </div>
          );
        }
        return (
          <div key={i} className={cn("flex items-stretch", ROW_BG[r.kind])}>
            <span className={GUTTER_CELL}>{r.oldNo ?? ""}</span>
            <span className={GUTTER_CELL}>{r.newNo ?? ""}</span>
            <span
              className={cn(
                "select-none w-4 shrink-0 text-center",
                r.kind === "add" && "text-green-700 dark:text-green-300",
                r.kind === "del" && "text-red-700 dark:text-red-300",
              )}
            >
              {SIGN[r.kind]}
            </span>
            <code className="block flex-1 pr-3 whitespace-pre">{r.text || " "}</code>
          </div>
        );
      })}
    </div>
  );
}
