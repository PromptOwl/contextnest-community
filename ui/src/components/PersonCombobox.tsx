/**
 * PersonCombobox — the add-a-person field: type-ahead over the people you
 * already work with, while still accepting an address that isn't on any list.
 *
 * Not a `SearchableSelect`: that control picks from a closed set of options,
 * and this one must stay open-ended — inviting someone who has no account yet
 * is the whole point of the "they'll get access when they register" copy that
 * sits under these fields. So the input owns the value and the suggestion list
 * only fills it in.
 *
 * Suggestions come from /people/suggest, which offers members of nests and
 * teams the caller already reaches (never the deployment's whole roster). They
 * are a convenience: the add itself is re-checked server-side.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { reads } from "../lib/queries";
import { personComboboxEnterAction } from "../lib/person-combobox";
import { cn } from "@/lib/utils";

/** Keystroke-to-request delay. See the debounce note in the component. */
const DEBOUNCE_MS = 200;

export interface PersonComboboxProps {
  value: string;
  onChange: (next: string) => void;
  /** Enter in the field submits the surrounding form; suppressed while a
   *  suggestion is highlighted so Enter picks it instead. */
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** Addresses already in use here (existing collaborators, current members) —
   *  offering them again is a dead end, so they're filtered out. */
  exclude?: string[];
  id?: string;
  className?: string;
  testId?: string;
}

export function PersonCombobox({
  value,
  onChange,
  onSubmit,
  placeholder = "name@company.com",
  disabled,
  exclude,
  id,
  className,
  testId,
}: PersonComboboxProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Debounced like the other search-box-to-server reads in the app (QuickOpen,
  // ActivityTracePage): the query key is the typed prefix, so firing it raw
  // would put a request on the wire per keystroke, each running a LIKE over the
  // caller's rosters. 200ms is under the gap between keystrokes and above the
  // cost of a wasted round trip.
  const [debounced, setDebounced] = useState(value.trim().toLowerCase());
  useEffect(() => {
    const t = setTimeout(
      () => setDebounced(value.trim().toLowerCase()),
      DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [value]);

  // One query per settled prefix, cached: the server does the filtering, so a
  // roster too large to ship whole still narrows as you type. The empty-query
  // read is the "just focused, show me who I work with" case.
  const { data } = useQuery({
    ...reads.peopleSuggest(debounced),
    enabled: open && !disabled,
  });

  const excluded = useMemo(
    () => new Set((exclude ?? []).map((e) => e.trim().toLowerCase())),
    [exclude],
  );
  const options = useMemo(
    () =>
      (data?.people ?? []).filter(
        (p) => !excluded.has(p.email.trim().toLowerCase()),
      ),
    [data, excluded],
  );

  // A narrowed list invalidates the old highlight index.
  useEffect(() => setHighlight(-1), [options.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const pick = (email: string) => {
    onChange(email);
    setOpen(false);
    setHighlight(-1);
  };

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <Input
        id={id}
        // Not type="email": the field is also a search box while you type, and
        // a partial name ("ada") would trip native email validation inside the
        // surrounding form before the picker could resolve it.
        type="text"
        inputMode="email"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        data-testid={testId}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        // Click, typing or ArrowDown opens it — not bare focus, which a dialog
        // gives its first field on open, dropping the list over the form.
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
            return;
          }
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
            return;
          }
          if (e.key === "Enter") {
            // Enter takes the highlighted person; with nothing highlighted it
            // submits what was typed, so a full address never needs the list.
            // Either way the list closes — left open, it kept querying
            // /people/suggest as the field cleared after a successful add,
            // reopening with every account once the empty-query result came
            // back (see personComboboxEnterAction).
            const action = personComboboxEnterAction(
              open,
              options.length,
              highlight,
            );
            if (action.type === "pick") {
              e.preventDefault();
              pick(options[action.index].email);
            } else if (onSubmit) {
              e.preventDefault();
              setOpen(false);
              onSubmit();
            }
            // Otherwise the key is NOT consumed. Swallowing it whenever the
            // list happened to be open — which it can be before a
            // character is typed — silently broke Enter-to-add in a form whose
            // caller hadn't wired onSubmit, where the plain <input> this
            // replaced had submitted natively.
            return;
          }
          if (!open || options.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((i) => (i + 1) % options.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((i) => (i <= 0 ? options.length - 1 : i - 1));
          } else if (e.key === "Tab" && highlight >= 0) {
            const chosen = options[highlight];
            if (chosen) {
              e.preventDefault();
              pick(chosen.email);
            }
          }
        }}
      />

      {open && options.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
        >
          {options.map((p, i) => (
            <li key={p.email}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                // Mouse-down, not click: the input's blur would close the list
                // before a click landed.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p.email);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full flex-col items-start px-3 py-1.5 text-left text-sm",
                  i === highlight ? "bg-accent text-accent-foreground" : "",
                )}
              >
                <span className="truncate font-medium">
                  {p.name || p.email.split("@")[0]}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {p.email}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
