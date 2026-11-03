/**
 * The tag board's "which tag group" box. It sits right beside the Columns-by
 * picker and is joined to it, so the two read as one control: "Tag" › "stage:".
 *
 * Lists the groups in use (stage:, surface:, …) with how many values and cards
 * each has, plus "All tags" (every tag its own column). Typing filters the list,
 * and a group no card carries yet can still be typed. This replaces a bare text
 * box that gave no hint of what to put in it.
 *
 * An in-place panel rather than a portalled popover, for the same reason as
 * TagColumnInput: it stays exactly under the field and needs no focus trap.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TagGroup } from "../../lib/board-dimensions";

const LIST_ID = "board-tag-group-list";
const optionId = (i: number) => `${LIST_ID}-${i}`;

interface Row {
  /** The namespace to group by; "" is every tag. */
  value: string;
  label: string;
  hint: string;
}

const bare = (s: string) => s.trim().replace(/^#/, "").split(":")[0]!.trim().toLowerCase();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function TagGroupInput({
  value,
  groups,
  onChange,
  borderless,
}: {
  /** The namespace now in use; empty groups by every tag. */
  value: string;
  groups: TagGroup[];
  onChange: (namespace: string) => void;
  /** Borderless, for sitting inside the toolbar's capsule next to the picker. */
  borderless?: boolean;
}) {
  const current = bare(value);
  const [text, setText] = useState("");
  // Only filter once the person has typed: opening shows the whole list.
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const typed = dirty ? bare(text) : "";

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (!typed || "all tags".includes(typed)) {
      out.push({ value: "", label: "All tags", hint: "every tag is a column" });
    }
    for (const g of groups) {
      if (typed && !g.namespace.includes(typed)) continue;
      out.push({
        value: g.namespace,
        label: `${g.namespace}:`,
        hint: `${plural(g.values, "value")} · ${plural(g.cards, "card")}`,
      });
    }
    if (typed && !groups.some((g) => g.namespace === typed)) {
      out.push({ value: typed, label: `Use “${typed}:”`, hint: "no cards carry it yet" });
    }
    return out;
  }, [typed, groups]);

  // The row for the group in use starts highlighted, so Enter keeps it.
  useEffect(() => {
    const i = rows.findIndex((r) => r.value === current);
    setActive(typed ? 0 : Math.max(i, 0));
  }, [rows, current, typed]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    setDirty(false);
  };

  const shown = open ? text : current ? `${current}:` : "";

  return (
    <div ref={wrapRef} className="relative">
      <Input
        value={shown}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
          setOpen(true);
        }}
        onFocus={(e) => {
          setText(current ? `${current}:` : "");
          setDirty(false);
          setOpen(true);
          e.currentTarget.select();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, rows.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const r = rows[active];
            if (r) choose(r.value);
          } else if (e.key === "Escape") {
            setOpen(false);
            setDirty(false);
          }
        }}
        placeholder="All tags"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={LIST_ID}
        aria-activedescendant={open && rows[active] ? optionId(active) : undefined}
        aria-label="Tag group"
        className={
          borderless
            ? "h-full w-32 rounded-none border-0 bg-transparent pl-1.5 pr-6 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            : "h-8 w-40 pr-7"
        }
        title="Which tags become columns. Pick a group like stage: to use only its values, or All tags."
        data-testid="board-tag-group"
      />
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-50" />
      {open && (
        <div
          id={LIST_ID}
          role="listbox"
          className="absolute left-0 z-50 mt-1 w-72 rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <div className="max-h-72 overflow-y-auto p-1">
            {rows.map((r, i) => (
              <button
                key={`${r.value}-${r.label}`}
                id={optionId(i)}
                type="button"
                role="option"
                aria-selected={r.value === current}
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r.value)}
                className={cn(
                  "flex w-full items-start justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                  i === active && "bg-accent text-accent-foreground",
                  r.value === current && "font-medium",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{r.hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
