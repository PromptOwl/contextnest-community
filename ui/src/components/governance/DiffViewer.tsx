/**
 * DiffViewer — renders a unified patch GitHub-style: per-line old/new line
 * numbers, a +/- sign gutter, and clear add/delete row backgrounds.
 *
 * Dependency-free. Patch parsing (hunk headers, line numbering) lives in
 * diff-rows.ts so it stays unit-testable without a DOM.
 */
import { cn } from "@/lib/utils";
import { toRows, type Row } from "./diff-rows";

interface DiffViewerProps {
  patch: string;
  className?: string;
}

const ROW_BG: Record<Row["kind"], string> = {
  add: "bg-green-100 dark:bg-green-950/50",
  del: "bg-red-100 dark:bg-red-950/50",
  ctx: "",
  hunk: "bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300",
};

const SIGN: Record<Row["kind"], string> = {
  add: "+",
  del: "-",
  ctx: " ",
  hunk: "",
};

const GUTTER_CELL =
  "select-none w-10 shrink-0 px-1 text-right tabular-nums text-[10px] text-muted-foreground/70 border-r border-border/60";

export function DiffViewer({ patch, className }: DiffViewerProps) {
  const rows = toRows(patch);

  return (
    <div
      className={cn(
        // Lines wrap instead of scrolling sideways: a horizontally scrolled row
        // paints its add/delete background only as far as the visible box, so
        // long lines showed a stripe that stopped mid-row.
        "rounded-md border bg-background font-mono text-xs leading-relaxed overflow-y-auto max-h-96",
        className,
      )}
      data-testid="diff-viewer"
    >
      {rows.map((r, i) => {
        // Hunk headers span the full width without line-number gutters.
        if (r.kind === "hunk") {
          return (
            <div
              key={i}
              className={cn(
                "px-3 whitespace-pre-wrap break-words",
                ROW_BG[r.kind],
              )}
            >
              {r.text || " "}
            </div>
          );
        }
        // items-stretch keeps the gutter rule running the full height of a
        // wrapped row; the number itself still sits on the first line.
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
            <code className="block flex-1 min-w-0 pr-3 whitespace-pre-wrap break-words">
              {r.text || " "}
            </code>
          </div>
        );
      })}
    </div>
  );
}
