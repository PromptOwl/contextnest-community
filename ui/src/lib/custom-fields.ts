/**
 * Custom fields on the client — pure, framework-free, unit-tested in the node
 * env (test/custom-fields-ui.test.ts).
 *
 * The server owns validation (src/nodes/custom-fields.ts); this owns how a
 * value READS: formatting, the live time-in-status clock, which fields a board
 * can group by, what a column key means and what writing one back looks like.
 *
 * Any surface that lists documents — the board, the task list view — should
 * render values through these helpers so a number reads "3 pts" and a
 * duration "2d 4h" the same everywhere:
 *
 *   const { data } = useQuery(reads.fields(nestId));          // definitions
 *   const cols = listColumnFields(data.fields, "task");         // what to show
 *   formatFieldValue(def, node.fields?.[def.key], { now, node, personLabel });
 */
import type { FieldDefinition, FieldType } from "./api";

export type { FieldDefinition, FieldType };

/** The catch-all column/lane on a field board (same sentinel as boards). */
export const NO_VALUE = "__uncategorized__";

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  select: "Select",
  multi_select: "Multi-select",
  date: "Date",
  user: "Person",
  url: "Link",
  checkbox: "Checkbox",
  time_in_status: "Time in status",
};

export const FIELD_TYPE_HINTS: Record<FieldType, string> = {
  text: "Free text, up to 2,000 characters",
  number: "A number, optionally with a scale like points or hours",
  select: "One option from a list",
  multi_select: "Any number of options from a list",
  date: "A calendar day",
  user: "Someone on this nest",
  url: "An http(s) link",
  checkbox: "On or off",
  time_in_status: "Computed — how long a task has sat in its current column",
};

/** Types a person writes a value for (everything but the computed one). */
export const WRITABLE_TYPES: FieldType[] = [
  "text",
  "number",
  "select",
  "multi_select",
  "date",
  "user",
  "url",
  "checkbox",
];

export function isComputed(def: Pick<FieldDefinition, "type">): boolean {
  return def.type === "time_in_status";
}

export function appliesTo(def: Pick<FieldDefinition, "applies_to">, type: string | undefined): boolean {
  return def.applies_to.includes("*") || def.applies_to.includes(type || "document");
}

/** Fields a node of this type carries, in the nest's order. */
export function applicableFields(defs: FieldDefinition[], type: string | undefined): FieldDefinition[] {
  return defs.filter((d) => appliesTo(d, type)).sort((a, b) => a.position - b.position);
}

/** Columns a list view should offer for nodes of `type` — every applicable field. */
export const listColumnFields = applicableFields;

/** Fields a board can make columns, lanes or quick filters of. */
export function isGroupable(def: Pick<FieldDefinition, "type">): boolean {
  return (
    def.type === "select" || def.type === "multi_select" || def.type === "user" || def.type === "checkbox"
  );
}

/** "3d 4h", "2h 5m", "12m", "<1m". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

/** Seconds in the current column, live from `status_since` when the client
 *  has it (so a card ticks without a refetch), else the server's snapshot. */
export function timeInStatus(
  node: { status_since?: string; fields?: Record<string, unknown> },
  def: Pick<FieldDefinition, "key">,
  now: number = Date.now(),
): number | undefined {
  if (node.status_since) {
    const t = Date.parse(node.status_since);
    if (!Number.isNaN(t)) return Math.max(0, Math.floor((now - t) / 1000));
  }
  const v = node.fields?.[def.key];
  return typeof v === "number" ? v : undefined;
}

/** Short unit for a number scale: "points" → "pts", "hours" → "h". */
export function unitSuffix(unit: string | null | undefined): string {
  if (!unit) return "";
  const u = unit.trim().toLowerCase();
  if (u === "points" || u === "point" || u === "pts") return "pts";
  if (u === "hours" || u === "hour" || u === "h") return "h";
  return unit.trim();
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A url value safe to put in an href: http(s) only, else undefined. Stored
 *  frontmatter can arrive verbatim (vault import, external edit), so a
 *  `javascript:` value must never reach an anchor. */
export function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A value as display text, or "" when unset. */
export function formatFieldValue(
  def: FieldDefinition,
  value: unknown,
  opts: {
    now?: number;
    node?: { status_since?: string; fields?: Record<string, unknown> };
    personLabel?: (email: string) => string;
  } = {},
): string {
  if (def.type === "time_in_status") {
    const s = opts.node
      ? timeInStatus(opts.node, def, opts.now)
      : typeof value === "number"
        ? value
        : undefined;
    return s === undefined ? "" : formatDuration(s);
  }
  if (value === undefined || value === null || value === "") return "";
  switch (def.type) {
    case "number": {
      const n = Number(value);
      const suffix = unitSuffix(def.unit);
      const shown = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
      return suffix === "h" ? `${shown}h` : suffix ? `${shown} ${suffix}` : shown;
    }
    case "multi_select":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "checkbox":
      return value === true ? def.label : "";
    case "date":
      return shortDate(String(value));
    case "user":
      return opts.personLabel ? opts.personLabel(String(value)) : String(value);
    case "url":
      try {
        const u = new URL(String(value));
        return u.host + (u.pathname === "/" ? "" : u.pathname);
      } catch {
        return String(value);
      }
    default:
      return String(value);
  }
}

/**
 * A restrained tone per select option — the same option always gets the same
 * tone, picked by its position in the definition. Muted fills with a
 * same-hue text, like Linear's labels; never saturated blocks.
 */
const TONES = [
  "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  "bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  "bg-orange-50 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
];
const DOTS = [
  "bg-slate-400",
  "bg-sky-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-orange-500",
];

export function optionTone(def: Pick<FieldDefinition, "options">, option: string): string {
  const i = def.options.indexOf(option);
  return TONES[(i < 0 ? 0 : i) % TONES.length]!;
}

export function optionDot(def: Pick<FieldDefinition, "options">, option: string): string {
  const i = def.options.indexOf(option);
  return DOTS[(i < 0 ? 0 : i) % DOTS.length]!;
}

// ── Board grouping ─────────────────────────────────────────────────────────

/** The column keys a value puts a card in. Checkbox columns are "true" and
 *  "false" (unset reads as false); everything else unset is NO_VALUE. */
export function fieldColumnKeys(def: Pick<FieldDefinition, "type">, value: unknown): string[] {
  if (def.type === "checkbox") return [value === true ? "true" : "false"];
  if (value === undefined || value === null || value === "") return [NO_VALUE];
  if (def.type === "multi_select") {
    const list = Array.isArray(value) ? value.map(String) : [String(value)];
    return list.length > 0 ? list : [NO_VALUE];
  }
  if (def.type === "user") return [String(value).toLowerCase()];
  return [String(value)];
}

/** Default left→right order: the options as defined; checkbox off first. */
export function fieldColumnOrder(
  def: Pick<FieldDefinition, "type" | "options">,
): string[] | undefined {
  if (def.type === "select" || def.type === "multi_select") return [...def.options];
  if (def.type === "checkbox") return ["false", "true"];
  return undefined;
}

/** Heading for a column / lane key. */
export function fieldKeyLabel(
  def: Pick<FieldDefinition, "type" | "label">,
  key: string,
  personLabel?: (email: string) => string,
): string {
  if (key === NO_VALUE) return def.type === "user" ? "Unassigned" : `No ${def.label.toLowerCase()}`;
  if (def.type === "checkbox") return key === "true" ? def.label : `Not ${def.label.toLowerCase()}`;
  if (def.type === "user") return personLabel ? personLabel(key) : key;
  return key;
}

/**
 * The value a card should carry after being dragged from `fromKey` to
 * `toKey` on a board grouped by `def`. Multi-select swaps the one option and
 * keeps the rest, the way a tag board swaps one tag.
 */
export function fieldValueForMove(
  def: Pick<FieldDefinition, "type">,
  current: unknown,
  toKey: string,
  fromKey?: string,
): unknown {
  if (def.type === "checkbox") return toKey === "true";
  if (def.type === "multi_select") {
    const list = Array.isArray(current) ? current.map(String) : [];
    const next = list.filter((v) => v !== fromKey);
    if (toKey === NO_VALUE) return next.length > 0 ? next : null;
    if (!next.includes(toKey)) next.push(toKey);
    return next;
  }
  return toKey === NO_VALUE ? null : toKey;
}

// ── Filters ────────────────────────────────────────────────────────────────

/** Same semantics as the server's matchesFieldFilter, for board filters. */
export function matchesFieldFilter(
  def: Pick<FieldDefinition, "type">,
  value: unknown,
  wanted: string,
): boolean {
  if (def.type === "checkbox") return (value === true) === (wanted === "true");
  if (wanted === "none" || wanted === "") {
    return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
  }
  if (value === undefined || value === null) return false;
  const w = wanted.toLowerCase();
  if (def.type === "multi_select") {
    return Array.isArray(value) && value.some((v) => String(v).toLowerCase() === w);
  }
  return String(value).toLowerCase() === w;
}

/** Every filter must match; a filter on a field the node can't carry fails. */
export function matchesFieldFilters(
  node: { type: string; fields?: Record<string, unknown> },
  filters: Record<string, string> | undefined,
  defs: FieldDefinition[],
): boolean {
  if (!filters) return true;
  for (const [key, wanted] of Object.entries(filters)) {
    const def = defs.find((d) => d.key === key);
    if (!def) continue; // a deleted field's filter no longer narrows anything
    if (!appliesTo(def, node.type)) return false;
    if (!matchesFieldFilter(def, node.fields?.[key], wanted)) return false;
  }
  return true;
}
