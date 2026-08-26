import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * A select you can type into — for lists long enough that scrolling is the
 * wrong interaction (every document in a nest, every tag). A plain `<Select>`
 * can't host a search field: its own typeahead swallows the keystrokes.
 *
 * The list is pinned to the field's width (measured, not content-driven) and a
 * long label wraps inside it, so neither the closed control nor the open list
 * can grow past the form.
 */

export interface SearchableOption {
  value: string;
  /** The line shown in the list and, truncated, in the closed control. */
  label: string;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  disabled,
  id,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  options: SearchableOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  // Measured on open. `--radix-popover-trigger-width` is not dependable across
  // Radix versions, and without a fixed width the list sizes to its longest
  // item and spills out of the dialog.
  const [width, setWidth] = useState<number>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((o) => o.value === value);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setWidth(triggerRef.current?.offsetWidth);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          data-testid={testId}
          className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span
            className={cn(
              "truncate text-left",
              !selected && "text-muted-foreground",
            )}
          >
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="p-0" align="start" style={{ width }}>
        <Command
          // `value` is the id/path — searchable even though it is not shown,
          // so a remembered path still finds the document.
          filter={(itemValue, search) => {
            const o = options.find((x) => x.value === itemValue);
            const hay = `${o?.label ?? ""} ${itemValue}`.toLowerCase();
            return hay.includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
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
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
