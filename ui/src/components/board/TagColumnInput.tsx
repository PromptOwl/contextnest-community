/**
 * The tag board's add-column box (CU-wdqcq05pad): type and pick a tag from the
 * nest's tags — with how many cards carry each, the ones already on the board
 * left out — or type a pattern like `status*` to add every matching tag as a
 * column, including tags that turn up later. Rows and the Enter target come
 * from lib/tag-column-input.ts.
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
import { columnInputRows } from "../../lib/tag-column-input";

const LIST_ID = "board-tag-column-list";
const optionId = (i: number) => `${LIST_ID}-${i}`;

export function TagColumnInput({
  suggestions,
  onAdd,
  autoFocus,
  onClose,
}: {
  /** Every tag not yet a column, most used first (board-dimensions tagSuggestions). */
  suggestions: Array<{ value: string; count: number }>;
  onAdd: (value: string) => void;
  /** Focus the box on mount (it was opened from the "+ Column" button). */
  autoFocus?: boolean;
  /** Escape pressed: the owner may collapse the box again. */
  onClose?: () => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const { rows, active: defaultActive } = useMemo(
    () => columnInputRows(text, suggestions),
    [text, suggestions],
  );
  const [active, setActive] = useState(defaultActive);
  const wrapRef = useRef<HTMLDivElement>(null);
  const typed = text.trim().replace(/^#/, "");

  useEffect(() => setActive(defaultActive), [defaultActive, text]);

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

  const current = open && active >= 0 ? rows[active] : undefined;

  return (
    <div ref={wrapRef} className="relative">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add(current ? current.value : typed);
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
              onClose?.();
            }
          }}
          autoFocus={autoFocus}
          placeholder="add column…"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={LIST_ID}
          aria-activedescendant={current ? optionId(active) : undefined}
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
          id={LIST_ID}
          role="listbox"
          className="absolute right-0 z-50 mt-1 w-72 rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <div className="max-h-72 overflow-y-auto p-1">
            {rows.map((r, i) => (
              <button
                key={`${r.kind}-${r.value}`}
                id={optionId(i)}
                type="button"
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => add(r.value)}
                className={cn(
                  "flex w-full items-start justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                  i === active && "bg-accent text-accent-foreground",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {r.kind === "pattern" && (
                      <Asterisk className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                    )}
                    {r.label}
                  </span>
                  {r.kind === "pattern" && r.hint && (
                    <span className="block text-xs text-muted-foreground">{r.hint}</span>
                  )}
                </span>
                {r.kind === "tag" && r.hint && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{r.hint}</span>
                )}
              </button>
            ))}
            {rows.length === 0 && (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                Every tag in use is already a column. Type a name to add an empty one.
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
