import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

/**
 * A select you can type into — for lists long enough that scrolling is the
 * wrong interaction (every document in a nest, every tag). A plain `<Select>`
 * can't host a search field: its own typeahead swallows the keystrokes.
 *
 * The list is a plain absolutely-positioned panel, NOT a portalled popover: a
 * portal escapes the dialog this is used inside, and the dialog's scroll lock
 * then eats the wheel events so the list can't be scrolled. Staying in the
 * dialog's own subtree also makes the panel exactly as wide as the field.
 */

export interface SearchableOption {
  value: string;
  /** The line shown in the list and, truncated, in the closed control. */
  label: string;
  /** Heading the option is listed under; options without one list ungrouped. */
  group?: string;
}

/** Does a typed search keep this option? The label always counts; the value
 *  (a path worth remembering) only when `searchValues`. */
export function optionMatches(o: SearchableOption | undefined, search: string, searchValues = true): boolean {
  if (!o) return false;
  return (searchValues ? `${o.label} ${o.value}` : o.label).toLowerCase().includes(search.trim().toLowerCase());
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  searchValues = true,
  disabled,
  id,
  testId,
  ariaLabel,
  className,
  buttonClassName,
}: {
  value: string;
  onChange: (next: string) => void;
  options: SearchableOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Off when values are opaque ids: a search then matches labels only. */
  searchValues?: boolean;
  disabled?: boolean;
  id?: string;
  testId?: string;
  ariaLabel?: string;
  /** The wrapper: sets the width of the field and its list. */
  className?: string;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  // Open upward when the field sits too low for the list (search + 300px list).
  const [up, setUp] = useState(false);
  const toggle = () => {
    if (!open && wrapRef.current) {
      const r = wrapRef.current.getBoundingClientRect();
      setUp(window.innerHeight - r.bottom < 360 && r.top > window.innerHeight - r.bottom);
    }
    setOpen((v) => !v);
  };
  const wrapRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  // Groups in the order their first option appears; one unnamed group otherwise.
  const groups: Array<[string | undefined, SearchableOption[]]> = [];
  for (const o of options) {
    const g = groups.find(([name]) => name === o.group);
    if (g) g[1].push(o);
    else groups.push([o.group, [o]]);
  }

  // Close on an outside click or Escape — the two things a portalled popover
  // would have handled for us.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Stop the dialog from closing too — Escape belongs to the open list.
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <button
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel ? `${ariaLabel}: ${selected?.label ?? placeholder}` : undefined}
        disabled={disabled}
        data-testid={testId}
        onClick={toggle}
        className={cn(
          "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          buttonClassName,
        )}
      >
        <span
          className={cn("truncate text-left", !selected && "text-muted-foreground")}
        >
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <div
          className={cn(
            "absolute z-50 w-full rounded-md border bg-popover text-popover-foreground shadow-md",
            up ? "bottom-full mb-1" : "mt-1",
          )}
        >
          <Command
            // `value` is the id/path — searchable even though it is not shown,
            // so a remembered path still finds the document.
            filter={(itemValue, search) =>
              optionMatches(options.find((x) => x.value === itemValue), search, searchValues) ? 1 : 0
            }
          >
            <CommandInput placeholder={searchPlaceholder} autoFocus />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              {groups.map(([heading, items]) => (
              <CommandGroup key={heading ?? ""} heading={heading}>
                {items.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={o.value}
                    className="items-start"
                    onSelect={(next) => {
                      onChange(next);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4 shrink-0",
                        o.value === value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="min-w-0 whitespace-normal break-words">
                      {o.label}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
