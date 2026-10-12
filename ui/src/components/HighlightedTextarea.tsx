/**
 * A textarea that shows comment highlights under its text.
 *
 * A textarea can't style ranges of its own text, so a mirror <div> with the
 * same font, padding, border and wrapping sits in the same grid cell beneath
 * it, its text transparent and the commented spans tinted. The mirror also
 * sizes the cell, so the box grows with its content (the page scrolls, not
 * the box) — no scroll syncing between the two layers, and the mirror's text
 * nodes give the place-keeping code real layout to read (data-place-surface).
 */
import { useMemo, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import type { SourceRange } from "../lib/view-place";

// Shared by both layers — any drift here misaligns the tint.
const LAYER =
  "col-start-1 row-start-1 w-full min-h-[400px] p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words border rounded-lg [overflow-wrap:anywhere]";

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "className"> {
  value: string;
  ranges: SourceRange[];
  activeId: string | null;
  /** Caret landed inside a highlighted span. */
  onRangeClick?: (id: string) => void;
}

export function HighlightedTextarea({
  value,
  ranges,
  activeId,
  onRangeClick,
  onClick,
  ...rest
}: Props) {
  // Non-overlapping segments in source order; overlaps keep the earlier span.
  const parts = useMemo(() => {
    const out: { text: string; id?: string }[] = [];
    let at = 0;
    for (const r of ranges) {
      if (r.start < at) continue;
      if (r.start > at) out.push({ text: value.slice(at, r.start) });
      out.push({ text: value.slice(r.start, r.end), id: r.id });
      at = r.end;
    }
    out.push({ text: value.slice(at) });
    return out;
  }, [value, ranges]);

  return (
    <div className="grid">
      <div
        aria-hidden
        data-place-surface
        data-testid="raw-markdown-highlights"
        className={cn(LAYER, "border-transparent text-transparent bg-background shadow-sm")}
      >
        {parts.map((p, i) =>
          p.id ? (
            <mark
              key={i}
              data-thread-id={p.id}
              className={cn(
                "rounded-sm text-transparent",
                p.id === activeId ? "bg-amber-400/65" : "bg-amber-400/30",
              )}
            >
              {p.text}
            </mark>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
        {/* A trailing newline only takes height with something after it. */}
        {"​"}
      </div>
      <textarea
        {...rest}
        value={value}
        onClick={(e) => {
          onClick?.(e);
          const pos = e.currentTarget.selectionStart;
          const hit = ranges.find((r) => pos >= r.start && pos <= r.end);
          if (hit) onRangeClick?.(hit.id);
        }}
        className={cn(
          LAYER,
          "relative self-stretch resize-none overflow-hidden bg-transparent focus:outline-none focus:ring-2 focus:ring-ring",
        )}
      />
    </div>
  );
}
