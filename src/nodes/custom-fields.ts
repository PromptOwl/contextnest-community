/**
 * Custom fields — defined per nest, stored per node.
 *
 * A nest admin (or a nest-scope reviewer steward) defines fields: a key, a
 * label, a type, select options, required/default, and which node types they
 * apply to (tasks unless widened). Definitions are nest configuration and live
 * in the `field_definitions` table (migration 062).
 *
 * VALUES live on the node, in frontmatter `metadata.fields` — next to the
 * assignee/due/priority keys task-fields.ts keeps in `metadata`. That is what
 * keeps them governed: every value change is an ordinary engine write, so it
 * seals a version, moves the hash chain, shows in history and diffs, and goes
 * through the same draft/review rules as any other edit. Nothing about a value
 * lives only in the database.
 *
 * Every write path (REST create/update, MCP context_create/context_update, the
 * web UI — which is REST) funnels through `applyFieldsPatch`, so one function
 * decides what a valid value is.
 *
 * Estimates and time-in-status are not features of their own: they are two
 * presets over this model. An estimate is a number field with a scale label
 * (points or hours). Time in status is a COMPUTED field — read-only, derived
 * from when the task entered its current board column (`moved_at`, stamped by
 * the update path in service.ts, falling back to `created_at`).
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import { ensureNodeIndex, readIndexedNodes } from "./node-index.js";
import { config } from "../config.js";
import { resolveNestAccess, isNestArchived } from "../shared/access.js";
import { getStewardsForUser } from "../governance/stewardship-service.js";
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from "../shared/errors.js";

/** Types a person or agent can write a value for. */
export const WRITABLE_FIELD_TYPES = [
  "text",
  "number",
  "select",
  "multi_select",
  "date",
  "user",
  "url",
  "checkbox",
] as const;
/** Server-computed, never written. */
export const COMPUTED_FIELD_TYPES = ["time_in_status"] as const;
export const FIELD_TYPES = [...WRITABLE_FIELD_TYPES, ...COMPUTED_FIELD_TYPES] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** One-click templates. `estimate` is a number with a scale label;
 *  `time_in_status` is the computed field. */
export const FIELD_PRESETS = ["estimate", "time_in_status"] as const;
export type FieldPreset = (typeof FIELD_PRESETS)[number];

/** Scale labels the Estimate preset offers. Free text is allowed too (≤ 20). */
export const ESTIMATE_UNITS = ["points", "hours"] as const;

/** Every node type — the `applies_to` wildcard. */
export const ANY_TYPE = "*";

export interface FieldDefinition {
  id: string;
  nest_id: string;
  key: string;
  label: string;
  type: FieldType;
  /** Allowed values, in display order (select / multi_select only). */
  options: string[];
  required: boolean;
  /** Filled in on create when the caller sends nothing for this field. */
  default_value: unknown;
  /** Node types the field applies to; ["*"] = every type. */
  applies_to: string[];
  /** Scale label for a number ("points", "hours"). */
  unit: string | null;
  preset: FieldPreset | null;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A field value patch: key → value, `null` clears. */
export type FieldsPatch = Record<string, unknown>;

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const MAX_LABEL = 60;
const MAX_OPTIONS = 100;
const MAX_OPTION_LEN = 60;
const MAX_TEXT = 2000;
const MAX_URL = 2000;
const MAX_FIELDS_PER_NEST = 50;
const MAX_APPLIES = 20;

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function isComputed(t: FieldType): boolean {
  return (COMPUTED_FIELD_TYPES as readonly string[]).includes(t);
}

export function isComputedField(def: Pick<FieldDefinition, "type">): boolean {
  return isComputed(def.type);
}

/** Does this definition apply to a node of `type`? */
export function appliesTo(def: Pick<FieldDefinition, "applies_to">, type: string | undefined): boolean {
  return def.applies_to.includes(ANY_TYPE) || def.applies_to.includes(type || "document");
}

// ─── Definition shape ──────────────────────────────────────────────────────

interface Row {
  id: string;
  nest_id: string;
  field_key: string;
  label: string;
  type: string;
  options_json: string;
  required: number;
  default_json: string | null;
  applies_to_json: string;
  unit: string | null;
  preset: string | null;
  position: number | string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toDefinition(r: Row): FieldDefinition {
  const options = parseJson<unknown>(r.options_json, []);
  const applies = parseJson<unknown>(r.applies_to_json, ["task"]);
  return {
    id: r.id,
    nest_id: r.nest_id,
    key: r.field_key,
    label: r.label,
    type: (FIELD_TYPES as readonly string[]).includes(r.type) ? (r.type as FieldType) : "text",
    options: Array.isArray(options) ? options.map(String) : [],
    required: !!r.required,
    default_value: parseJson<unknown>(r.default_json, null),
    applies_to: Array.isArray(applies) && applies.length > 0 ? applies.map(String) : ["task"],
    unit: r.unit ?? null,
    preset: (FIELD_PRESETS as readonly string[]).includes(r.preset ?? "")
      ? (r.preset as FieldPreset)
      : null,
    position: Number(r.position),
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listFieldDefinitions(nestId: string): Promise<FieldDefinition[]> {
  const rows = (await getDb().all(
    "SELECT * FROM field_definitions WHERE nest_id = ? ORDER BY position, created_at",
    [nestId],
  )) as Row[];
  return rows.map(toDefinition);
}

async function getDefinition(nestId: string, idOrKey: string): Promise<FieldDefinition> {
  const row = (await getDb().get(
    "SELECT * FROM field_definitions WHERE nest_id = ? AND (id = ? OR field_key = ?)",
    [nestId, idOrKey, idOrKey],
  )) as Row | undefined;
  if (!row) throw new NotFoundError(`No field "${idOrKey}" on this nest`);
  return toDefinition(row);
}

/**
 * Who may define fields: the nest owner, a nest admin, the server
 * license-admin, or a reviewer steward scoped to the whole nest — the people
 * who already govern this nest's settings and content. Throws otherwise, and
 * on an archived nest for everyone.
 */
export async function assertCanManageFields(nestId: string, userId: string): Promise<void> {
  if (config.AUTH_MODE === "open") {
    if (await isNestArchived(nestId)) {
      throw new ForbiddenError("This nest is archived, so it is read-only. Restore it to change its fields.");
    }
    return;
  }
  const access = await resolveNestAccess(nestId, userId);
  if (!access.exists) throw new NotFoundError("Nest not found");
  if (access.archived) {
    throw new ForbiddenError("This nest is archived, so it is read-only. Restore it to change its fields.");
  }
  if (access.rawPermission === "owner" || access.rawPermission === "admin") return;
  if (access.callerEmail) {
    const rows = await getStewardsForUser(nestId, access.callerEmail);
    if (rows.some((s) => s.role === "reviewer" && s.scope === "nest")) return;
  }
  throw new ForbiddenError(
    "Only a nest admin, the nest owner, or a nest-wide reviewer steward can define fields.",
  );
}

/** Whether the caller could manage fields — for UI affordances. Never throws. */
export async function canManageFields(nestId: string, userId: string): Promise<boolean> {
  try {
    await assertCanManageFields(nestId, userId);
    return true;
  } catch {
    return false;
  }
}

export interface DefinitionInput {
  key?: unknown;
  label?: unknown;
  type?: unknown;
  options?: unknown;
  required?: unknown;
  default_value?: unknown;
  applies_to?: unknown;
  unit?: unknown;
  preset?: unknown;
  position?: unknown;
}

/** What a preset fills in when the caller leaves it out. */
export function presetDefaults(preset: FieldPreset, unit?: string): Required<
  Pick<DefinitionInput, "key" | "label" | "type">
> & { unit: string | null } {
  if (preset === "estimate") {
    return { key: "estimate", label: "Estimate", type: "number", unit: unit ?? "points" };
  }
  return { key: "time_in_status", label: "Time in status", type: "time_in_status", unit: null };
}

function cleanLabel(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ValidationError("label is required");
  const label = raw.trim();
  if (label.length > MAX_LABEL) {
    throw new ValidationError(`label must be at most ${MAX_LABEL} characters`);
  }
  return label;
}

function cleanOptions(raw: unknown, type: FieldType): string[] {
  const usesOptions = type === "select" || type === "multi_select";
  if (raw === undefined || raw === null) {
    if (usesOptions) throw new ValidationError(`a ${type} field needs at least one option`);
    return [];
  }
  if (!usesOptions) {
    if (Array.isArray(raw) && raw.length === 0) return [];
    throw new ValidationError(`options only apply to select and multi_select fields`);
  }
  if (!Array.isArray(raw)) throw new ValidationError("options must be a list of strings");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const o of raw) {
    if (typeof o !== "string") throw new ValidationError("options must be a list of strings");
    const v = o.trim();
    if (!v) continue;
    if (v.length > MAX_OPTION_LEN) {
      throw new ValidationError(`option "${v.slice(0, 20)}…" is over ${MAX_OPTION_LEN} characters`);
    }
    if (seen.has(v.toLowerCase())) throw new ValidationError(`option "${v}" is listed twice`);
    seen.add(v.toLowerCase());
    out.push(v);
  }
  if (out.length === 0) throw new ValidationError(`a ${type} field needs at least one option`);
  if (out.length > MAX_OPTIONS) throw new ValidationError(`at most ${MAX_OPTIONS} options`);
  return out;
}

function cleanAppliesTo(raw: unknown): string[] {
  if (raw === undefined || raw === null) return ["task"];
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || list.some((t) => typeof t !== "string")) {
    throw new ValidationError('applies_to must be a list of node types, or ["*"] for every type');
  }
  const types = [...new Set((list as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (types.length === 0) return ["task"];
  if (types.includes(ANY_TYPE)) return [ANY_TYPE];
  if (types.length > MAX_APPLIES) throw new ValidationError("applies_to lists too many types");
  for (const t of types) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(t)) {
      throw new ValidationError(`"${t}" isn't a node type`);
    }
  }
  return types;
}

function cleanUnit(raw: unknown, type: FieldType): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (type !== "number") throw new ValidationError("unit only applies to number fields");
  if (typeof raw !== "string" || raw.trim().length > 20) {
    throw new ValidationError("unit must be a short label like points or hours");
  }
  return raw.trim();
}

/**
 * Validate one value against its definition and return what is stored.
 * `null` (or an empty string / empty list) means "clear". Throws a
 * ValidationError naming the field on anything else that doesn't fit.
 */
export async function normalizeFieldValue(
  def: Pick<FieldDefinition, "key" | "label" | "type" | "options">,
  raw: unknown,
  roster: () => Promise<Set<string>>,
): Promise<unknown> {
  const name = `${def.label} (${def.key})`;
  if (isComputed(def.type)) {
    throw new ValidationError(`${name} is computed by the server and can't be set`);
  }
  if (raw === null || raw === undefined) return null;
  switch (def.type) {
    case "text": {
      if (typeof raw !== "string") throw new ValidationError(`${name} must be text`);
      const v = raw.trim();
      if (!v) return null;
      if (v.length > MAX_TEXT) throw new ValidationError(`${name} must be at most ${MAX_TEXT} characters`);
      return v;
    }
    case "number": {
      const n =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.trim() !== "" && /^-?\d+(\.\d+)?$/.test(raw.trim())
            ? Number(raw.trim())
            : typeof raw === "string" && raw.trim() === ""
              ? null
              : NaN;
      if (n === null) return null;
      if (!Number.isFinite(n)) throw new ValidationError(`${name} must be a number, got "${String(raw)}"`);
      if (Math.abs(n) > 1e12) throw new ValidationError(`${name} is out of range`);
      return n;
    }
    case "select": {
      if (typeof raw !== "string") throw new ValidationError(`${name} must be one of: ${def.options.join(", ")}`);
      const v = raw.trim();
      if (!v) return null;
      const match = def.options.find((o) => o.toLowerCase() === v.toLowerCase());
      if (!match) {
        throw new ValidationError(`${name} must be one of: ${def.options.join(", ")} — got "${v}"`);
      }
      return match;
    }
    case "multi_select": {
      const list = typeof raw === "string" ? [raw] : raw;
      if (!Array.isArray(list)) throw new ValidationError(`${name} must be a list of options`);
      const out: string[] = [];
      for (const item of list) {
        if (typeof item !== "string") throw new ValidationError(`${name} must be a list of options`);
        const match = def.options.find((o) => o.toLowerCase() === item.trim().toLowerCase());
        if (!match) {
          throw new ValidationError(`${name}: "${item}" isn't an option (${def.options.join(", ")})`);
        }
        if (!out.includes(match)) out.push(match);
      }
      if (out.length === 0) return null;
      // Stored in option order, so the same set always hashes the same.
      return def.options.filter((o) => out.includes(o));
    }
    case "date": {
      const v = raw instanceof Date ? raw.toISOString().slice(0, 10) : raw;
      if (typeof v !== "string") throw new ValidationError(`${name} must be a date like 2026-10-31`);
      if (!v.trim()) return null;
      // Round-trip, not just Date.parse: some engines roll 2026-02-31 over
      // to March instead of returning NaN.
      const day = v.trim();
      const parsed = Date.parse(`${day}T00:00:00Z`);
      if (
        !DATE_RE.test(day) ||
        Number.isNaN(parsed) ||
        new Date(parsed).toISOString().slice(0, 10) !== day
      ) {
        throw new ValidationError(`${name} must be a date like 2026-10-31, got "${v}"`);
      }
      return v.trim();
    }
    case "user": {
      if (typeof raw !== "string") throw new ValidationError(`${name} must be an email address`);
      const v = raw.trim().toLowerCase();
      if (!v) return null;
      if (!EMAIL_RE.test(v)) throw new ValidationError(`${name} must be an email address, got "${raw}"`);
      if (!(await roster()).has(v)) {
        throw new ValidationError(`${name}: ${v} isn't on this nest — share the nest with them first`);
      }
      return v;
    }
    case "url": {
      if (typeof raw !== "string") throw new ValidationError(`${name} must be a URL`);
      const v = raw.trim();
      if (!v) return null;
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        throw new ValidationError(`${name} must be a full URL like https://example.com, got "${v}"`);
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new ValidationError(`${name} must be an http(s) URL`);
      }
      if (v.length > MAX_URL) throw new ValidationError(`${name} is too long`);
      return v;
    }
    case "checkbox": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new ValidationError(`${name} must be true or false`);
    }
  }
  throw new ValidationError(`${name} has an unknown type`);
}

/** Stored values off a node's metadata — only keys a definition still names
 *  are interpreted by clients, but nothing is dropped from storage. */
export function storedFieldsOf(metadata: unknown): Record<string, unknown> {
  const m = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  const f = m.fields;
  if (!f || typeof f !== "object" || Array.isArray(f)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
    // YAML reads a bare 2026-10-10 as a Date — normalize back to the day.
    out[k] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
  }
  return out;
}

/**
 * Apply a patch to a node's stored values.
 *
 * - Unknown keys and keys whose definition doesn't apply to this node type are
 *   refused, naming what IS defined — an agent's typo must not vanish.
 * - Computed fields are refused.
 * - On create (`isCreate`), defaults fill unset fields, then every required
 *   field must hold a value.
 * - On update, clearing a required field is refused; fields left alone are
 *   not re-checked, so defining a new required field doesn't make every older
 *   document unsavable.
 *
 * Returns the full next map (empty → caller clears `metadata.fields`) and
 * whether it differs from `current`.
 */
export async function applyFieldsPatch(args: {
  defs: FieldDefinition[];
  nodeType: string | undefined;
  current: Record<string, unknown>;
  patch: FieldsPatch | undefined;
  isCreate: boolean;
  roster: () => Promise<Set<string>>;
}): Promise<{ fields: Record<string, unknown>; changed: boolean }> {
  const { defs, nodeType, current, isCreate, roster } = args;
  const patch = args.patch ?? {};
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new ValidationError("fields must be an object of field key → value");
  }
  const applicable = defs.filter((d) => appliesTo(d, nodeType));
  const byKey = new Map(applicable.map((d) => [d.key, d]));
  const next: Record<string, unknown> = { ...current };

  for (const [key, raw] of Object.entries(patch)) {
    const def = byKey.get(key);
    if (!def) {
      const exists = defs.find((d) => d.key === key);
      if (exists) {
        throw new ValidationError(
          `field "${key}" doesn't apply to ${nodeType || "document"} nodes (it applies to ${exists.applies_to.join(", ")})`,
        );
      }
      const known = applicable.filter((d) => !isComputed(d.type)).map((d) => d.key);
      throw new ValidationError(
        `unknown field "${key}"${known.length ? ` — this nest defines: ${known.join(", ")}` : " — this nest defines no fields for this node type"}`,
      );
    }
    const value = await normalizeFieldValue(def, raw, roster);
    if (value === null) {
      if (def.required) throw new ValidationError(`${def.label} (${def.key}) is required`);
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  if (isCreate) {
    for (const def of applicable) {
      if (isComputed(def.type) || next[def.key] !== undefined) continue;
      if (def.default_value !== null && def.default_value !== undefined) {
        const v = await normalizeFieldValue(def, def.default_value, roster);
        if (v !== null) next[def.key] = v;
      }
      if (def.required && next[def.key] === undefined) {
        throw new ValidationError(`${def.label} (${def.key}) is required`);
      }
    }
  }

  const changed = JSON.stringify(sortKeys(next)) !== JSON.stringify(sortKeys(current));
  return { fields: sortKeys(next), changed };
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

// ─── Computed values ───────────────────────────────────────────────────────

/** When a node entered its current column: the last move, else creation. */
export function statusSince(n: { moved_at?: string; created_at?: string }): string | undefined {
  return n.moved_at || n.created_at || undefined;
}

/** Whole seconds a node has sat in its current column, or undefined. */
export function timeInStatusSeconds(
  n: { moved_at?: string; created_at?: string },
  nowMs: number = Date.now(),
): number | undefined {
  const since = statusSince(n);
  if (!since) return undefined;
  const t = Date.parse(since);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

/** "3d 4h", "2h 5m", "12m", "<1m" — for prose surfaces (MCP). */
export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

/**
 * Add computed field values to node responses in place: every
 * time_in_status definition that applies to a node gets the node's seconds in
 * its current column under its key. `fields` on a response is therefore the
 * stored values PLUS the computed ones; writes refuse the computed keys.
 */
export function addComputedFields<
  T extends { type?: string; fields?: Record<string, unknown>; moved_at?: string; created_at?: string },
>(nodes: T[], defs: FieldDefinition[], nowMs: number = Date.now()): T[] {
  const computed = defs.filter((d) => d.type === "time_in_status");
  if (computed.length === 0) return nodes;
  for (const n of nodes) {
    for (const def of computed) {
      if (!appliesTo(def, n.type)) continue;
      const s = timeInStatusSeconds(n, nowMs);
      if (s === undefined) continue;
      n.fields = { ...(n.fields ?? {}), [def.key]: s };
    }
  }
  return nodes;
}

/** Human-readable `Label: value` lines for prose surfaces (MCP). */
export function describeFields(
  fields: Record<string, unknown> | undefined,
  defs: FieldDefinition[],
): string[] {
  if (!fields) return [];
  const lines: string[] = [];
  for (const def of defs) {
    const v = fields[def.key];
    if (v === undefined || v === null) continue;
    let shown: string;
    if (def.type === "time_in_status" && typeof v === "number") shown = formatDuration(v);
    else if (Array.isArray(v)) shown = v.join(", ");
    else if (def.type === "checkbox") shown = v ? "yes" : "no";
    else if (def.type === "number" && def.unit) shown = `${v} ${def.unit}`;
    else shown = String(v);
    lines.push(`${def.label}: ${shown}`);
  }
  return lines;
}

// ─── Filtering ─────────────────────────────────────────────────────────────

/**
 * Does a node's value match a filter value? The filter is a string (from a
 * query param) or a scalar (from MCP). `"none"`, `""` and `null` match an
 * unset field. Per type:
 *   select, user, date, url, number → equality (case-insensitive strings)
 *   multi_select → contains the option
 *   checkbox → "true"/"false" (unset counts as false)
 *   text → case-insensitive substring
 */
export function matchesFieldFilter(
  def: Pick<FieldDefinition, "type">,
  value: unknown,
  wanted: unknown,
): boolean {
  const none = wanted === null || wanted === "" || wanted === "none";
  if (def.type === "checkbox") {
    const want = wanted === true || wanted === "true" || wanted === "yes" || wanted === "1";
    return (value === true) === want;
  }
  if (none) return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
  if (value === undefined || value === null) return false;
  const w = String(wanted).trim().toLowerCase();
  switch (def.type) {
    case "multi_select":
      return Array.isArray(value) && value.some((v) => String(v).toLowerCase() === w);
    case "text":
      return String(value).toLowerCase().includes(w);
    case "number":
    case "time_in_status":
      return Number(value) === Number(wanted);
    default:
      return String(value).toLowerCase() === w;
  }
}

/** Validate a filter map against the nest's definitions (unknown key → 400). */
export function assertFilterKeys(filters: Record<string, unknown>, defs: FieldDefinition[]): void {
  for (const [key, wanted] of Object.entries(filters)) {
    const def = defs.find((d) => d.key === key);
    if (!def) {
      throw new ValidationError(
        `can't filter on "${key}" — this nest defines: ${defs.map((d) => d.key).join(", ") || "no fields"}`,
      );
    }
    // A non-numeric number filter would silently match nothing.
    if (
      (def.type === "number" || def.type === "time_in_status") &&
      wanted !== null &&
      wanted !== "" &&
      wanted !== "none" &&
      !Number.isFinite(Number(wanted))
    ) {
      throw new ValidationError(`${def.label} (${key}) filters by a number, got "${String(wanted)}"`);
    }
  }
}

// ─── Stored values vs a definition ─────────────────────────────────────────

/** A roster check that only looks at shape — for re-validating values that
 *  were already accepted, where the person may since have left the nest. */
const shapeOnlyRoster = async () =>
  new Proxy(new Set<string>(), { get: (t, p) => (p === "has" ? () => true : (t as any)[p]) }) as Set<string>;

/**
 * Nodes whose stored value under `def.key` no longer validates against
 * `def` — after narrowing options or applies_to, or before re-creating a
 * deleted key with a different type. Reads the index mirror (frontmatter
 * only, no file reads).
 */
export async function nodesWithInvalidValues(
  nestId: string,
  def: Pick<FieldDefinition, "key" | "label" | "type" | "options" | "applies_to">,
): Promise<string[]> {
  if (isComputed(def.type)) return [];
  await ensureNodeIndex(nestId);
  const bad: string[] = [];
  for (const n of await readIndexedNodes(nestId)) {
    const stored = storedFieldsOf(n.frontmatter.metadata);
    if (!(def.key in stored)) continue;
    if (!appliesTo(def, n.frontmatter.type)) {
      bad.push(n.id);
      continue;
    }
    try {
      await normalizeFieldValue(def, stored[def.key], shapeOnlyRoster);
    } catch {
      bad.push(n.id);
    }
  }
  return bad;
}

// ─── Definition history (audit) ────────────────────────────────────────────

export interface FieldDefinitionEvent {
  id: string;
  nest_id: string;
  field_key: string;
  action: "create" | "update" | "delete";
  actor_id: string | null;
  actor_email: string | null;
  before: Partial<FieldDefinition> | null;
  after: Partial<FieldDefinition> | null;
  at: string;
}

/** The parts of a definition worth auditing (ids and timestamps aren't). */
function auditShape(d: FieldDefinition | null): Partial<FieldDefinition> | null {
  if (!d) return null;
  const { id: _i, nest_id: _n, created_at: _c, updated_at: _u, created_by: _b, ...rest } = d;
  return rest;
}

async function recordDefinitionEvent(
  nestId: string,
  key: string,
  action: FieldDefinitionEvent["action"],
  actorId: string,
  before: FieldDefinition | null,
  after: FieldDefinition | null,
): Promise<void> {
  await getDb().run(
    `INSERT INTO field_definition_events (id, nest_id, field_key, action, actor_id, before_json, after_json, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      nestId,
      key,
      action,
      actorId,
      before ? JSON.stringify(auditShape(before)) : null,
      after ? JSON.stringify(auditShape(after)) : null,
      new Date().toISOString(),
    ],
  );
}

/** Who changed which definition, and from what to what — newest first. */
export async function listFieldDefinitionEvents(
  nestId: string,
  limit = 100,
): Promise<FieldDefinitionEvent[]> {
  const rows = (await getDb().all(
    `SELECT e.*, u.email AS actor_email FROM field_definition_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.nest_id = ? ORDER BY e.at DESC LIMIT ?`,
    [nestId, Math.max(1, Math.min(500, Math.floor(limit)))],
  )) as Array<Record<string, any>>;
  return rows.map((r) => ({
    id: r.id,
    nest_id: r.nest_id,
    field_key: r.field_key,
    action: r.action,
    actor_id: r.actor_id ?? null,
    actor_email: r.actor_email ?? null,
    before: parseJson(r.before_json, null),
    after: parseJson(r.after_json, null),
    at: r.at,
  }));
}

// ─── Definition CRUD ───────────────────────────────────────────────────────

/** Check a default against the definition being saved (roster not consulted:
 *  a user default is re-validated, roster and all, on every create). */
async function cleanDefault(
  raw: unknown,
  def: Pick<FieldDefinition, "key" | "label" | "type" | "options">,
): Promise<unknown> {
  if (raw === undefined || raw === null || raw === "") return null;
  if (isComputed(def.type)) throw new ValidationError("a computed field has no default");
  return normalizeFieldValue(def, raw, async () => new Set([String(raw).trim().toLowerCase()]));
}

export async function createFieldDefinition(
  nestId: string,
  userId: string,
  input: DefinitionInput,
): Promise<FieldDefinition> {
  await assertCanManageFields(nestId, userId);
  let preset: FieldPreset | null = null;
  if (input.preset !== undefined && input.preset !== null && input.preset !== "") {
    if (!(FIELD_PRESETS as readonly unknown[]).includes(input.preset)) {
      throw new ValidationError(`preset must be one of ${FIELD_PRESETS.join(", ")}`);
    }
    preset = input.preset as FieldPreset;
  }
  const base = preset
    ? presetDefaults(preset, typeof input.unit === "string" ? input.unit : undefined)
    : null;
  const type = (input.type ?? base?.type) as FieldType;
  if (!(FIELD_TYPES as readonly unknown[]).includes(type)) {
    throw new ValidationError(`type must be one of ${FIELD_TYPES.join(", ")}`);
  }
  if (preset === "estimate" && type !== "number") {
    throw new ValidationError("the estimate preset is a number field");
  }
  if (preset === "time_in_status" && type !== "time_in_status") {
    throw new ValidationError("the time_in_status preset is a computed field");
  }
  const key = String(input.key ?? base?.key ?? "").trim();
  if (!KEY_RE.test(key)) {
    throw new ValidationError(
      "key must start with a letter and use only lowercase letters, digits and _ (max 40)",
    );
  }
  const label = cleanLabel(input.label ?? base?.label);
  const options = cleanOptions(input.options, type);
  const unit = cleanUnit(input.unit ?? base?.unit, type);
  const applies = cleanAppliesTo(input.applies_to);
  const required = input.required === true;
  if (required && isComputed(type)) throw new ValidationError("a computed field can't be required");
  const defaultValue = await cleanDefault(input.default_value, { key, label, type, options });

  const db = getDb();
  const existing = (await db.get(
    "SELECT COUNT(*) AS n FROM field_definitions WHERE nest_id = ?",
    [nestId],
  )) as { n: number | string };
  if (Number(existing.n) >= MAX_FIELDS_PER_NEST) {
    throw new ValidationError(`a nest can define at most ${MAX_FIELDS_PER_NEST} fields`);
  }
  const taken = await db.get(
    "SELECT 1 AS present FROM field_definitions WHERE nest_id = ? AND field_key = ?",
    [nestId, key],
  );
  if (taken) throw new ConflictError(`A field with key "${key}" already exists on this nest`);
  // A deleted key's values are still on documents. Re-creating it as a type
  // they don't fit would reinterpret governed history — refuse instead.
  const stale = await nodesWithInvalidValues(nestId, {
    key,
    label,
    type,
    options,
    applies_to: [ANY_TYPE],
  });
  if (stale.length > 0) {
    throw new ConflictError(
      `${stale.length} document${stale.length === 1 ? "" : "s"} still carr${stale.length === 1 ? "ies" : "y"} "${key}" values from an earlier field that aren't valid as ${type}${options.length ? ` (${options.join(", ")})` : ""} — use another key, or define it to fit them`,
    );
  }
  if (type === "time_in_status") {
    const other = await db.get(
      "SELECT field_key FROM field_definitions WHERE nest_id = ? AND type = 'time_in_status'",
      [nestId],
    );
    if (other) throw new ConflictError("This nest already has a time-in-status field");
  }
  const max = (await db.get(
    "SELECT COALESCE(MAX(position), -1) AS p FROM field_definitions WHERE nest_id = ?",
    [nestId],
  )) as { p: number | string };
  const id = randomUUID();
  const ts = now();
  await db.run(
    `INSERT INTO field_definitions
       (id, nest_id, field_key, label, type, options_json, required, default_json,
        applies_to_json, unit, preset, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      nestId,
      key,
      label,
      type,
      JSON.stringify(options),
      required ? 1 : 0,
      defaultValue === null ? null : JSON.stringify(defaultValue),
      JSON.stringify(applies),
      unit,
      preset,
      Number(max.p) + 1,
      userId,
      ts,
      ts,
    ],
  );
  const created = await getDefinition(nestId, id);
  await recordDefinitionEvent(nestId, key, "create", userId, null, created);
  return created;
}

/**
 * Change a definition. The key and type are fixed once created: values on
 * nodes are keyed by it and were validated as that type, so changing either
 * would silently reinterpret governed history. Delete and re-create instead.
 */
export async function updateFieldDefinition(
  nestId: string,
  idOrKey: string,
  userId: string,
  input: DefinitionInput,
): Promise<FieldDefinition> {
  await assertCanManageFields(nestId, userId);
  const def = await getDefinition(nestId, idOrKey);
  if (input.key !== undefined && input.key !== def.key) {
    throw new ValidationError("a field's key can't change — values on documents are stored under it");
  }
  if (input.type !== undefined && input.type !== def.type) {
    throw new ValidationError("a field's type can't change — delete it and define a new one");
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  const next = { ...def };
  if (input.label !== undefined) {
    next.label = cleanLabel(input.label);
    sets.push("label = ?");
    params.push(next.label);
  }
  if (input.options !== undefined) {
    next.options = cleanOptions(input.options, def.type);
    sets.push("options_json = ?");
    params.push(JSON.stringify(next.options));
  }
  if (input.unit !== undefined) {
    next.unit = cleanUnit(input.unit, def.type);
    sets.push("unit = ?");
    params.push(next.unit);
  }
  if (input.applies_to !== undefined) {
    next.applies_to = cleanAppliesTo(input.applies_to);
    sets.push("applies_to_json = ?");
    params.push(JSON.stringify(next.applies_to));
  }
  if (input.required !== undefined) {
    if (input.required === true && isComputed(def.type)) {
      throw new ValidationError("a computed field can't be required");
    }
    next.required = input.required === true;
    sets.push("required = ?");
    params.push(next.required ? 1 : 0);
  }
  if (input.default_value !== undefined || input.options !== undefined) {
    // An options edit can orphan the stored default — re-check it.
    const raw = input.default_value !== undefined ? input.default_value : def.default_value;
    next.default_value = await cleanDefault(raw, next);
    sets.push("default_json = ?");
    params.push(next.default_value === null ? null : JSON.stringify(next.default_value));
  }
  if (input.position !== undefined) {
    const p = input.position;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 10_000) {
      throw new ValidationError("position must be an integer from 0 to 10000");
    }
    sets.push("position = ?");
    params.push(p);
  }
  if (sets.length === 0) return def;
  sets.push("updated_at = ?");
  params.push(now());
  await getDb().run(`UPDATE field_definitions SET ${sets.join(", ")} WHERE id = ?`, [
    ...(params as any[]),
    def.id,
  ]);
  const updated = await getDefinition(nestId, def.id);
  await recordDefinitionEvent(nestId, def.key, "update", userId, def, updated);
  return updated;
}

/**
 * Remove a definition. Values already on documents stay in their frontmatter
 * and history — deleting a definition is not an edit of any document, so it
 * seals no versions. Clients stop showing the key; re-creating the same key
 * brings the values back.
 */
export async function deleteFieldDefinition(
  nestId: string,
  idOrKey: string,
  userId: string,
): Promise<FieldDefinition> {
  await assertCanManageFields(nestId, userId);
  const def = await getDefinition(nestId, idOrKey);
  await getDb().run("DELETE FROM field_definitions WHERE id = ?", [def.id]);
  await recordDefinitionEvent(nestId, def.key, "delete", userId, def, null);
  return def;
}
