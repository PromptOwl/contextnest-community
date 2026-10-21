/**
 * The tag board's add-column box (CU-wdqcq05pad): type and pick a tag from the
 * nest's tags — with how many cards carry each, the ones already on the board
 * left out — or type a pattern like `status*` to add every matching tag as a
 * column, including tags that turn up later.
 *
 * A native <datalist> was here before. Browsers show it inconsistently (Chrome
 * only after typing, with no counts and no hint that patterns exist), which is
 * most of why setting up a status board felt hard. The list is an in-place
 * panel rather than a portalled popover for the same reason as
 * SearchableSelect: it stays exactly under the field and needs no focus trap.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Asterisk, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { globMatch, isColumnPattern } from "../../lib/board-dimensions";

const MAX_SHOWN = 50;

export function TagColumnInput({
  suggestions,
  onAdd,
}: {
  /** Every tag not yet a column, most used first (board-dimensions tagSuggestions). */
  suggestions: Array<{ value: string; count: number }>;
  onAdd: (value: string) => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const typed = text.trim().replace(/^#/, "");
  const pattern = isColumnPattern(typed);
  const matches = useMemo(() => {
    if (!typed) return suggestions;
    const q = typed.toLowerCase();
    return suggestions.filter((s) =>
      pattern ? globMatch(typed, s.value) : s.value.toLowerCase().includes(q),
    );
  }, [suggestions, typed, pattern]);

  // Rows: for a pattern, one "add the pattern" row (its matches are listed as
  // a preview, not picked one by one); otherwise the matching tags, then the
  // typed text as a new tag when it isn't one of them.
  const rows: Array<{ value: string; label: string; hint?: string }> = pattern
    ? [
        {
          value: typed,
          label: `Add a column for every tag matching “${typed}”`,
          hint: matches.length
            ? `${matches.length} now: ${matches
                .slice(0, 4)
                .map((m) => m.value)
                .join(", ")}${matches.length > 4 ? "…" : ""} — new matches appear by themselves`
            : "No tags match yet — matching tags will appear as columns when they're used",
        },
      ]
    : [
        ...matches.slice(0, MAX_SHOWN).map((m) => ({
          value: m.value,
          label: m.value,
          hint: `${m.count}`,
        })),
        ...(typed && !matches.some((m) => m.value.toLowerCase() === typed.toLowerCase())
          ? [{ value: typed, label: `New tag “${typed}”` }]
          : []),
      ];

  useEffect(() => setActive(0), [typed]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const add = (value: string) => {
    if (!value.trim()) return;
    onAdd(value);
    setText("");
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add(open && rows[active] ? rows[active].value : typed);
        }}
        className="flex items-center gap-1"
      >
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder="add column…"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="board-tag-column-list"
          className="h-8 w-40"
          title="Add a tag column — pick a tag, type a new one, or a pattern like status* for every matching tag"
          data-testid="board-add-tag-column"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!typed} title="Add column">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </form>
      {open && (
        <div
          id="board-tag-column-list"
          role="listbox"
          className="absolute right-0 z-50 mt-1 w-72 rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <div className="max-h-72 overflow-y-auto p-1">
            {rows.map((r, i) => (
              <button
                key={`${r.value}-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => add(r.value)}
                className={cn(
                  "flex w-full items-start justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                  i === active && "bg-accent text-accent-foreground",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {pattern && <Asterisk className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />}
                    {r.label}
                  </span>
                  {pattern && r.hint && (
                    <span className="block text-xs text-muted-foreground">{r.hint}</span>
                  )}
                </span>
                {!pattern && r.hint && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{r.hint}</span>
                )}
              </button>
            ))}
            {rows.length === 0 && (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                Every tag is already a column.
              </div>
            )}
          </div>
          <div className="border-t px-2 py-1.5 text-xs text-muted-foreground">
            Tip: <code>status*</code> adds a column for every tag starting with “status”.
          </div>
        </div>
      )}
    </div>
  );
}
