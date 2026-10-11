/**
 * Custom-field pieces shared by the board card, the document's Fields panel
 * and the board's filter bar. Formatting and grouping rules live in
 * lib/custom-fields (pure, tested); these only render and report.
 *
 * Visual language follows the card's existing footer: 11px text, muted
 * chips, lucide glyphs at 3.5 — a field never shouts louder than the title.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Clock3,
  Gauge,
  Link2,
  CalendarDays,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Avatar, type Person } from "../board/CardParts";
import {
  NO_VALUE,
  fieldKeyLabel,
  formatFieldValue,
  isComputed,
  optionDot,
  optionTone,
  type FieldDefinition,
} from "../../lib/custom-fields";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

// ── Read-only chip (board cards) ──────────────────────────────────────────

/**
 * One value as a compact chip. Select options get their tone; a number shows
 * its scale; time in status ticks from `status_since`. Returns null when the
 * field has nothing to show, so a card never carries empty placeholders.
 */
export function FieldChip({
  def,
  node,
  now,
  personLabel,
}: {
  def: FieldDefinition;
  node: { status_since?: string; fields?: Record<string, unknown> };
  now: number;
  personLabel: (email: string) => string;
}) {
  const value = node.fields?.[def.key];
  const text = formatFieldValue(def, value, { now, node, personLabel });
  if (!text) return null;
  const title = `${def.label}: ${text}`;
  const base =
    "inline-flex max-w-[11rem] items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px] leading-none";
  if (def.type === "select") {
    return (
      <span className={cn(base, optionTone(def, String(value)))} title={title}>
        {String(value)}
      </span>
    );
  }
  if (def.type === "multi_select" && Array.isArray(value)) {
    return (
      <>
        {value.map((v) => (
          <span key={v} className={cn(base, optionTone(def, String(v)))} title={`${def.label}: ${v}`}>
            {String(v)}
          </span>
        ))}
      </>
    );
  }
  const icon: Record<string, ReactNode> = {
    number: <Gauge className="h-3 w-3 shrink-0" />,
    time_in_status: <Clock3 className="h-3 w-3 shrink-0" />,
    date: <CalendarDays className="h-3 w-3 shrink-0" />,
    url: <Link2 className="h-3 w-3 shrink-0" />,
    checkbox: <Check className="h-3 w-3 shrink-0" />,
  };
  if (def.type === "user") {
    return (
      <span className={cn(base, "bg-muted text-muted-foreground")} title={title}>
        <Avatar email={String(value)} size="sm" />
        <span className="truncate">{text}</span>
      </span>
    );
  }
  return (
    <span
      className={cn(base, "border border-border/70 text-muted-foreground tabular-nums")}
      title={title}
    >
      {icon[def.type]}
      <span className="truncate">{text}</span>
    </span>
  );
}

// ── Editor (the document's Fields panel) ──────────────────────────────────

/**
 * Edits one value and reports it on commit (blur / Enter / pick). `null`
 * clears. Text-like inputs keep a local draft so typing doesn't write per
 * keystroke; pickers commit immediately.
 */
export function FieldValueEditor({
  def,
  value,
  node,
  now,
  people,
  personLabel,
  disabled,
  onCommit,
}: {
  def: FieldDefinition;
  value: unknown;
  node: { status_since?: string; fields?: Record<string, unknown> };
  now: number;
  people: Person[];
  personLabel: (email: string) => string;
  disabled: boolean;
  onCommit: (next: unknown) => void;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);

  const shell =
    "h-8 w-full rounded-md border border-transparent bg-transparent px-2 text-sm hover:border-input focus:border-input focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

  if (isComputed(def)) {
    const text = formatFieldValue(def, value, { now, node });
    return (
      <span
        className="flex h-8 items-center gap-1.5 px-2 text-sm tabular-nums text-muted-foreground"
        title="Computed from when this task entered its current column"
      >
        <Clock3 className="h-3.5 w-3.5" />
        {text || "—"}
      </span>
    );
  }

  if (def.type === "checkbox") {
    return (
      <span className="flex h-8 items-center px-2">
        <Switch
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(v) => onCommit(v)}
          aria-label={def.label}
        />
      </span>
    );
  }

  if (def.type === "select" || def.type === "user") {
    const options =
      def.type === "select"
        ? def.options.map((o) => ({ value: o, label: o }))
        : people
            .filter((p) => p.member !== false)
            .map((p) => ({ value: p.email.toLowerCase(), label: p.name || p.email }));
    const current = value == null ? null : String(value);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          className={cn(shell, "flex items-center justify-between gap-2 text-left")}
        >
          {current ? (
            def.type === "select" ? (
              <span className={cn("rounded px-1.5 py-0.5 text-xs", optionTone(def, current))}>
                {current}
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <Avatar email={current} size="sm" />
                <span className="truncate">{personLabel(current)}</span>
              </span>
            )
          ) : (
            <span className="text-muted-foreground">Empty</span>
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {options.length === 0 && (
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {def.type === "user" ? "Nobody else is on this nest yet" : "No options"}
            </DropdownMenuLabel>
          )}
          {options.map((o) => (
            <DropdownMenuItem key={o.value} onSelect={() => onCommit(o.value)} className="gap-2">
              {def.type === "select" ? (
                <span className={cn("h-2 w-2 rounded-full", optionDot(def, o.value))} />
              ) : (
                <Avatar email={o.value} size="sm" />
              )}
              <span className="truncate">{o.label}</span>
              {current === o.value && <Check className="ml-auto h-3.5 w-3.5" />}
            </DropdownMenuItem>
          ))}
          {current && !def.required && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onCommit(null)} className="text-muted-foreground">
                Clear
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (def.type === "multi_select") {
    const current = Array.isArray(value) ? value.map(String) : [];
    const toggle = (o: string) => {
      const next = current.includes(o) ? current.filter((v) => v !== o) : [...current, o];
      onCommit(next.length > 0 ? next : null);
    };
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          className={cn(shell, "flex h-auto min-h-8 items-center justify-between gap-2 py-1 text-left")}
        >
          {current.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {current.map((v) => (
                <span key={v} className={cn("rounded px-1.5 py-0.5 text-xs", optionTone(def, v))}>
                  {v}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">Empty</span>
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {def.options.map((o) => (
            <DropdownMenuCheckboxItem
              key={o}
              checked={current.includes(o)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => toggle(o)}
            >
              <span className={cn("mr-2 h-2 w-2 rounded-full", optionDot(def, o))} />
              {o}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const inputType =
    def.type === "number" ? "number" : def.type === "date" ? "date" : def.type === "url" ? "url" : "text";
  const commit = () => {
    const v = draft.trim();
    const prev = value == null ? "" : String(value);
    if (v === prev) return;
    if (v === "") onCommit(null);
    else onCommit(def.type === "number" ? Number(v) : v);
  };
  return (
    <span className="flex items-center gap-1">
      <input
        type={inputType}
        value={draft}
        disabled={disabled}
        placeholder="Empty"
        step={def.type === "number" ? "any" : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(value == null ? "" : String(value));
        }}
        className={cn(shell, "placeholder:text-muted-foreground", def.type === "number" && "tabular-nums")}
        aria-label={def.label}
      />
      {def.type === "number" && def.unit && (
        <span className="shrink-0 text-xs text-muted-foreground">{def.unit}</span>
      )}
      {def.type === "url" && typeof value === "string" && value && (
        <a
          href={value}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Open link"
        >
          <Link2 className="h-3.5 w-3.5" />
        </a>
      )}
    </span>
  );
}

// ── Board quick filter ────────────────────────────────────────────────────

/** "Severity: Any ▾" — pick one value (or "No value") to narrow the board. */
export function FieldFilterMenu({
  def,
  value,
  people,
  personLabel,
  onChange,
}: {
  def: FieldDefinition;
  value: string | undefined;
  people: Person[];
  personLabel: (email: string) => string;
  onChange: (next: string | undefined) => void;
}) {
  const choices: Array<{ key: string; label: string }> =
    def.type === "checkbox"
      ? [
          { key: "true", label: def.label },
          { key: "false", label: `Not ${def.label.toLowerCase()}` },
        ]
      : def.type === "user"
        ? people
            .filter((p) => p.member !== false)
            .map((p) => ({ key: p.email.toLowerCase(), label: p.name || p.email }))
        : def.options.map((o) => ({ key: o, label: o }));
  const shown =
    value === undefined
      ? null
      : value === "none"
        ? fieldKeyLabel(def, NO_VALUE)
        : def.type === "user"
          ? personLabel(value)
          : def.type === "checkbox"
            ? fieldKeyLabel(def, value)
            : value;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors",
          value !== undefined
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-input text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <span className="font-medium">{def.label}</span>
        {shown && <span className="max-w-[8rem] truncate">: {shown}</span>}
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52" onClick={stop}>
        <DropdownMenuItem onSelect={() => onChange(undefined)}>
          Any
          {value === undefined && <Check className="ml-auto h-3.5 w-3.5" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {choices.map((c) => (
          <DropdownMenuItem key={c.key} onSelect={() => onChange(c.key)} className="gap-2">
            {def.type === "user" ? (
              <Avatar email={c.key} size="sm" />
            ) : def.type !== "checkbox" ? (
              <span className={cn("h-2 w-2 rounded-full", optionDot(def, c.key))} />
            ) : null}
            <span className="truncate">{c.label}</span>
            {value === c.key && <Check className="ml-auto h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
        {def.type !== "checkbox" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange("none")} className="text-muted-foreground">
              {fieldKeyLabel(def, NO_VALUE)}
              {value === "none" && <Check className="ml-auto h-3.5 w-3.5" />}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
