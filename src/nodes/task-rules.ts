/**
 * Task rules — the per-nest settings that keep a task board tidy when many
 * people and agents write to it at once.
 *
 *   - exclusive tag namespaces: a task carries at most ONE tag from each listed
 *     namespace (`stage:backlog`, `stage:done` → namespace `stage`). Adding one
 *     swaps out the old one, so a board whose columns are a tag namespace can
 *     never show a card in two columns.
 *   - default stage: the tag a new task gets when it arrives with none from an
 *     exclusive namespace, so every new card lands in a column.
 *   - ticket numbers: `ABC-123`. A nest has ONE prefix and ONE counter
 *     (ticket-numbers.ts); every task gets the next number, stamped once as the
 *     tag `ticket:abc-123`, and it never changes. Which product area a task is
 *     in is a separate attribute — its SURFACE, a display name plus the tags
 *     that identify it — so retagging a task between surfaces never touches its
 *     number. Nothing here names a particular organisation: all settings.
 *
 * Pure: no database, no clock. The service layer reads the settings and calls
 * these, so the rules are testable without a nest.
 */
import { ValidationError } from "../shared/errors.js";

/** Tag namespace the ticket number is stamped under: `ticket:cm-123`. */
export const TICKET_NAMESPACE = "ticket";

/** A product area a nest sorts its tasks into. Not part of the ticket number. */
export interface Surface {
  /** Display name, unique in the nest ("Community Nest"). */
  name: string;
  /** Tags (no `#`, lower case) that put a task in this surface. The first is
   *  the one the create dialog adds. */
  tags: string[];
}

/** One priority level. */
export interface PriorityLevel {
  /** Stored on the task: lower-case slug ("p1", "urgent"). */
  key: string;
  /** Shown to people ("P1 — Drop everything"). */
  label: string;
}

/** What a nest gets until it defines its own. Most urgent first. */
export const DEFAULT_PRIORITIES: readonly PriorityLevel[] = [
  { key: "urgent", label: "Urgent" },
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
];

export interface TaskRules {
  /** Namespaces (the part before the colon) a task may hold one tag from. */
  exclusive_namespaces: string[];
  /** Tag added to a new task that has none from an exclusive namespace.
   *  Null/absent: new tasks get no default. */
  default_stage_tag: string | null;
  /** The nest's surfaces, in priority order: a task is in the first one any of
   *  whose tags it carries. Used for filtering, lanes and the create dialog —
   *  never for the ticket number. */
  surfaces: Surface[];
  /** Name of the surface the create dialog preselects. Null: none. */
  default_surface: string | null;
  /** Number tasks as they are created. Off until a nest opts in. */
  ticket_numbering: boolean;
  /** The nest's single ticket prefix: 2–6 capitals/digits ("PO"). Required to
   *  turn numbering on. Changing it only affects tickets issued afterwards. */
  ticket_prefix: string | null;
  /** First number issued. Saved settings raise the counter to `start_at - 1`
   *  (never lower it), so a team moving from another tracker keeps its
   *  sequence. Null: numbering starts at 1. */
  ticket_start_at: number | null;
  /** The columns of the stage group (the namespace of `default_stage_tag`, else
   *  the first exclusive namespace), in workflow order — bare values
   *  (`["backlog","in-progress","done"]`). A board grouped by that namespace
   *  uses this order until someone reorders it by hand. Empty: alphabetical. */
  stage_order: string[];
  /** The nest's priority levels, most urgent first (2–8). Empty: the defaults
   *  (urgent, high, medium, low). Tasks keep the key they were given, so
   *  removing a level never rewrites a task — it just stops being offered. */
  priorities: PriorityLevel[];
}

export const NO_TASK_RULES: TaskRules = {
  exclusive_namespaces: [],
  default_stage_tag: null,
  surfaces: [],
  default_surface: null,
  ticket_numbering: false,
  ticket_prefix: null,
  ticket_start_at: null,
  priorities: [],
  stage_order: [],
};

const PREFIX_RE = /^[A-Z][A-Z0-9]{1,5}$/;
const NAMESPACE_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const TAG_NAME_RE = /^[a-z0-9][a-z0-9_:-]{0,60}$/;
const MAX_SURFACES = 40;
const MAX_SURFACE_TAGS = 20;
const MAX_NAMESPACES = 10;
const MAX_PRIORITIES = 8;
const MAX_STAGES = 20;
const PRIORITY_KEY_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;

/** `#Stage:Done` → `stage:done`. */
export const bareTag = (t: unknown): string =>
  String(t).trim().replace(/^#+/, "").toLowerCase();

/** The namespace of a tag — `stage` for `#stage:done` — or null when the tag
 *  has no colon. */
export function tagNamespace(tag: unknown): string | null {
  const bare = bareTag(tag);
  const i = bare.indexOf(":");
  return i > 0 && i < bare.length - 1 ? bare.slice(0, i) : null;
}

/** Read stored settings. Anything malformed reads as "off" rather than
 *  throwing, so a hand-edited row can't take task writes down. */
export function parseTaskRules(raw: string | null | undefined): TaskRules {
  if (!raw) return { ...NO_TASK_RULES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...NO_TASK_RULES };
  }
  try {
    return cleanTaskRules(parsed, { strict: false });
  } catch {
    return { ...NO_TASK_RULES };
  }
}

/**
 * Shape-check settings from a request (strict) or from storage (lenient).
 * Strict mode names the first problem; lenient drops bad entries.
 */
export function cleanTaskRules(raw: unknown, opts: { strict?: boolean } = {}): TaskRules {
  const strict = opts.strict !== false;
  const bad = (msg: string): never => {
    throw new ValidationError(msg);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return strict ? bad("task_rules must be an object") : { ...NO_TASK_RULES };
  }
  const r = raw as Record<string, unknown>;
  const known = [
    "exclusive_namespaces",
    "default_stage_tag",
    "surfaces",
    "default_surface",
    "ticket_numbering",
    "ticket_prefix",
    "ticket_start_at",
    "priorities",
    "stage_order",
  ];
  const unknown = Object.keys(r).filter((k) => !known.includes(k));
  if (strict && unknown.length > 0) {
    bad(`task_rules has unknown field(s): ${unknown.join(", ")} — allowed: ${known.join(", ")}`);
  }

  const out: TaskRules = { ...NO_TASK_RULES, surfaces: [] };

  if (r.exclusive_namespaces !== undefined) {
    if (!Array.isArray(r.exclusive_namespaces)) {
      if (strict) bad("task_rules.exclusive_namespaces must be a list of names");
    } else {
      const seen = new Set<string>();
      for (const n of r.exclusive_namespaces) {
        const ns = bareTag(n).replace(/:$/, "");
        if (!NAMESPACE_RE.test(ns)) {
          if (strict) bad(`"${String(n)}" is not a valid tag namespace (letters, digits, - or _)`);
          continue;
        }
        seen.add(ns);
      }
      if (seen.size > MAX_NAMESPACES) {
        if (strict) bad(`task_rules.exclusive_namespaces has more than ${MAX_NAMESPACES} entries`);
      }
      out.exclusive_namespaces = [...seen].slice(0, MAX_NAMESPACES);
    }
  }

  if (r.default_stage_tag !== undefined && r.default_stage_tag !== null && r.default_stage_tag !== "") {
    const tag = bareTag(r.default_stage_tag);
    if (!TAG_NAME_RE.test(tag)) {
      if (strict) bad(`"${String(r.default_stage_tag)}" is not a valid tag`);
    } else {
      out.default_stage_tag = tag;
    }
  }

  if (r.surfaces !== undefined) {
    if (!Array.isArray(r.surfaces)) {
      if (strict) bad("task_rules.surfaces must be a list of {name, tags}");
    } else {
      if (r.surfaces.length > MAX_SURFACES && strict) {
        bad(`task_rules.surfaces has more than ${MAX_SURFACES} entries`);
      }
      const names = new Set<string>();
      for (const raw of r.surfaces.slice(0, MAX_SURFACES)) {
        const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const name = typeof e.name === "string" ? e.name.trim() : "";
        const tagList = Array.isArray(e.tags) ? e.tags : [];
        const tags = [...new Set(tagList.map(bareTag))].slice(0, MAX_SURFACE_TAGS);
        const problem =
          !name || name.length > 40
            ? `a surface needs a name of 1–40 characters (got "${String(e.name ?? "")}")`
            : tags.length === 0 || tags.some((t) => !TAG_NAME_RE.test(t))
              ? `surface "${name}" needs at least one valid tag that identifies it`
              : names.has(name.toLowerCase())
                ? `two surfaces are named "${name}"`
                : null;
        if (problem) {
          if (strict) bad(problem);
          continue;
        }
        names.add(name.toLowerCase());
        out.surfaces.push({ name, tags });
      }
    }
  }

  if (r.default_surface !== undefined && r.default_surface !== null && r.default_surface !== "") {
    const want = typeof r.default_surface === "string" ? r.default_surface.trim().toLowerCase() : "";
    const hit = out.surfaces.find((x) => x.name.toLowerCase() === want);
    if (!hit) {
      if (strict) bad(`task_rules.default_surface "${String(r.default_surface)}" is not one of the surfaces`);
    } else {
      out.default_surface = hit.name;
    }
  }

  if (r.stage_order !== undefined) {
    if (!Array.isArray(r.stage_order)) {
      if (strict) bad("task_rules.stage_order must be a list of stage names");
    } else {
      const seen = new Set<string>();
      for (const v of r.stage_order.slice(0, MAX_STAGES + 1)) {
        const name = bareTag(v).replace(/^[a-z0-9_-]+:/, "");
        if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) {
          if (strict) bad(`"${String(v)}" is not a valid stage name (letters, digits, - or _)`);
          continue;
        }
        seen.add(name);
      }
      if (strict && r.stage_order.length > MAX_STAGES) bad(`task_rules.stage_order has more than ${MAX_STAGES} stages`);
      out.stage_order = [...seen].slice(0, MAX_STAGES);
    }
  }

  if (r.priorities !== undefined) {
    if (!Array.isArray(r.priorities)) {
      if (strict) bad("task_rules.priorities must be a list of {key, label}");
    } else if (r.priorities.length > 0) {
      const seen = new Set<string>();
      const levels: PriorityLevel[] = [];
      for (const raw of r.priorities.slice(0, MAX_PRIORITIES + 1)) {
        const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const label = typeof e.label === "string" ? e.label.trim() : "";
        // A level typed as just a label ("Blocker") gets a slug from it.
        const keyRaw = typeof e.key === "string" && e.key.trim() ? e.key : label;
        const key = keyRaw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const problem = !label || label.length > 24
          ? `a priority needs a label of 1–24 characters (got "${String(e.label ?? "")}")`
          : !PRIORITY_KEY_RE.test(key)
            ? `priority "${label}": the key must be 1–20 lower-case letters, digits or dashes`
            : seen.has(key)
              ? `two priorities use the key "${key}"`
              : null;
        if (problem) {
          if (strict) bad(problem);
          continue;
        }
        seen.add(key);
        levels.push({ key, label });
      }
      if (strict && (levels.length < 2 || r.priorities.length > MAX_PRIORITIES)) {
        bad(`task_rules.priorities needs 2–${MAX_PRIORITIES} levels (or leave it empty for the defaults)`);
      }
      out.priorities = levels.length >= 2 ? levels.slice(0, MAX_PRIORITIES) : [];
    }
  }

  if (r.ticket_prefix !== undefined && r.ticket_prefix !== null && r.ticket_prefix !== "") {
    const prefix = typeof r.ticket_prefix === "string" ? r.ticket_prefix.trim().toUpperCase() : "";
    if (!PREFIX_RE.test(prefix)) {
      if (strict) {
        bad(`task_rules.ticket_prefix must be 2–6 capital letters or digits starting with a letter (got "${String(r.ticket_prefix)}")`);
      }
    } else {
      out.ticket_prefix = prefix;
    }
  }

  if (r.ticket_start_at !== undefined && r.ticket_start_at !== null && r.ticket_start_at !== "") {
    const n = Number(r.ticket_start_at);
    if (!Number.isInteger(n) || n < 1 || n > 999_999_999) {
      if (strict) bad("task_rules.ticket_start_at must be a whole number from 1 to 999999999");
    } else if (n > 1) {
      out.ticket_start_at = n;
    }
  }

  if (r.ticket_numbering !== undefined) {
    if (typeof r.ticket_numbering !== "boolean") {
      if (strict) bad("task_rules.ticket_numbering must be true or false");
    } else {
      out.ticket_numbering = r.ticket_numbering;
    }
  }
  // Numbering with nothing to number by is a mistake in a request, and simply
  // "off" when read back from storage.
  if (out.ticket_numbering && !out.ticket_prefix) {
    if (strict) bad("Set task_rules.ticket_prefix (for example \"PO\") before turning ticket numbering on.");
    out.ticket_numbering = false;
  }

  return out;
}

/**
 * The prefix a nest gets until it picks its own: its name's leading acronym
 * ("PO - Engineering Ops" → PO), else the initials of its first words
 * ("Community Nest" → CN), else the first letters of a one-word name, else TASK.
 * Always valid for `ticket_prefix`.
 */
export function defaultTicketPrefix(nestName: string): string {
  const words = String(nestName ?? "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const first = words[0] ?? "";
  if (PREFIX_RE.test(first)) return first;
  const initials = words.slice(0, 4).map((w) => w[0]!).join("").toUpperCase();
  if (PREFIX_RE.test(initials)) return initials;
  const letters = first.toUpperCase().slice(0, 3);
  return PREFIX_RE.test(letters) ? letters : "TASK";
}

/** What a nest that has never saved task rules gets: tasks are numbered. */
export const defaultTaskRules = (nestName: string): TaskRules => ({
  ...NO_TASK_RULES,
  ticket_numbering: true,
  ticket_prefix: defaultTicketPrefix(nestName),
});

/** Stored form. */
export const serializeTaskRules = (rules: TaskRules): string => JSON.stringify(rules);

/**
 * Apply the exclusive-namespace rule to a tag set.
 *
 * `prior` is what the node had, `next` what the caller wants. Within a
 * namespace, a tag the caller ADDED wins over one it kept, so "add
 * stage:in-review" alone swaps the stage instead of leaving two. If the caller
 * added several from one namespace, or none were prior and several arrive (a
 * create), the set is ambiguous and `ambiguous` names the namespace — the
 * caller decides whether that is an error (create) or keep-the-last (update).
 * Tags are compared and returned as given in `next` (callers store them with
 * the leading `#`).
 */
export function applyExclusiveNamespaces(
  prior: readonly string[],
  next: readonly string[],
  namespaces: readonly string[],
): { tags: string[]; ambiguous: string[]; dropped: string[] } {
  if (namespaces.length === 0) return { tags: [...next], ambiguous: [], dropped: [] };
  const priorSet = new Set(prior.map(bareTag));
  const ambiguous: string[] = [];
  const dropped: string[] = [];
  let tags = [...next];
  for (const ns of namespaces) {
    const inNs = tags.filter((t) => tagNamespace(t) === ns);
    if (inNs.length <= 1) continue;
    const added = inNs.filter((t) => !priorSet.has(bareTag(t)));
    if (added.length > 1) ambiguous.push(ns);
    // Winner: the last tag added this call, else (nothing new) the last listed.
    const winner = added.length > 0 ? added[added.length - 1] : inNs[inNs.length - 1];
    for (const t of inNs) if (t !== winner) dropped.push(bareTag(t));
    tags = tags.filter((t) => tagNamespace(t) !== ns || t === winner);
  }
  return { tags, ambiguous, dropped };
}

/** The ticket tag a node carries (`ticket:cm-123`), if any. */
export function ticketTagOf(tags: readonly string[]): string | null {
  return tags.map(bareTag).find((t) => tagNamespace(t) === TICKET_NAMESPACE) ?? null;
}

/** `cm-123` → `CM-123`. */
export function ticketFromTag(tag: string): string | null {
  const bare = bareTag(tag);
  if (tagNamespace(bare) !== TICKET_NAMESPACE) return null;
  const id = bare.slice(TICKET_NAMESPACE.length + 1);
  return /^[a-z][a-z0-9]{1,5}-\d+$/.test(id) ? id.toUpperCase() : null;
}

export const formatTicket = (prefix: string, n: number): string => `${prefix}-${n}`;

export const ticketTag = (ticket: string): string => `#${TICKET_NAMESPACE}:${ticket.toLowerCase()}`;

/** The surface a task is in: the first surface (in the nest's order) with a tag
 *  the task carries, else null. */
export function surfaceFor(tags: readonly string[], rules: TaskRules): Surface | null {
  const have = new Set(tags.map(bareTag));
  for (const sf of rules.surfaces) if (sf.tags.some((t) => have.has(t))) return sf;
  return null;
}

/** The prefix new tickets get, or null when the nest isn't numbering. */
export const ticketPrefixOf = (rules: TaskRules): string | null =>
  rules.ticket_numbering ? rules.ticket_prefix : null;

/** The levels in force: the nest's own, else the defaults. */
export const effectivePriorities = (rules: Pick<TaskRules, "priorities">): readonly PriorityLevel[] =>
  rules.priorities.length >= 2 ? rules.priorities : DEFAULT_PRIORITIES;
