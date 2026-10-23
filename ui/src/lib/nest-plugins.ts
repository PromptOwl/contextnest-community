/**
 * Nest Plugins page logic, kept out of the components so it can be tested on
 * its own: who may do what, the settings form a plugin's JSON Schema
 * describes, and the PUT body a form produces.
 *
 * Coarse UI gating only — the server decides every action (configure: nest
 * owner/admin; run: write; read: anyone with access). A mistake here is a
 * confusing button, never a security hole.
 */
import type { ConfigurePluginBody, NestPlugin, PluginRun } from "./api";

/** The server sends a stored secret back as this, and only this. */
export const SECRET_MASK = "••••";

/** admin = owner/admin (configure + run), editor = write (run), viewer = read. */
export type PluginRole = "admin" | "editor" | "viewer";

export function pluginRole(
  permission: string | null | undefined,
  opts: { isArchived?: boolean } = {},
): PluginRole {
  if (opts.isArchived) return "viewer";
  if (permission === "owner" || permission === "admin") return "admin";
  if (permission === "write") return "editor";
  return "viewer";
}

export function roleAllows(role: PluginRole, action: "configure" | "run"): boolean {
  return action === "configure" ? role === "admin" : role !== "viewer";
}

export type PluginFieldKind = "text" | "secret" | "integer" | "number" | "boolean" | "select";

export interface PluginField {
  key: string;
  title: string;
  description?: string;
  kind: PluginFieldKind;
  required: boolean;
  options?: string[];
  defaultValue?: unknown;
  min?: number;
  max?: number;
  pattern?: string;
}

/** One form field per schema property, in the order the plugin declared them. */
export function pluginFields(plugin: NestPlugin): PluginField[] {
  const props = plugin.settingsSchema?.properties ?? {};
  const required = new Set(plugin.settingsSchema?.required ?? []);
  return Object.entries(props).map(([key, def]) => {
    const secret = !!def["x-secret"] || plugin.secretKeys.includes(key);
    const kind: PluginFieldKind = secret
      ? "secret"
      : def.enum?.length
        ? "select"
        : def.type === "integer"
          ? "integer"
          : def.type === "number"
            ? "number"
            : def.type === "boolean"
              ? "boolean"
              : "text";
    return {
      key,
      title: def.title || key,
      ...(def.description ? { description: def.description } : {}),
      kind,
      required: required.has(key),
      ...(kind === "select" ? { options: def.enum } : {}),
      ...(def.default !== undefined ? { defaultValue: def.default } : {}),
      ...(def.minimum !== undefined ? { min: def.minimum } : {}),
      ...(def.maximum !== undefined ? { max: def.maximum } : {}),
      ...(def.pattern ? { pattern: def.pattern } : {}),
    };
  });
}

/** Whether a secret is stored for this key (the server says so with the mask). */
export const secretIsSet = (plugin: NestPlugin, key: string) => plugin.settings[key] === SECRET_MASK;

/**
 * The form's state. Values are strings (or booleans for switches); secrets
 * always start empty — a stored one is shown by the field's placeholder,
 * never put in the input. `clear` marks stored secrets to delete.
 */
export interface PluginDraft {
  values: Record<string, string | boolean>;
  folder: string;
  clear: Record<string, boolean>;
}

export function draftFromPlugin(plugin: NestPlugin): PluginDraft {
  const values: Record<string, string | boolean> = {};
  for (const f of pluginFields(plugin)) {
    const v = plugin.settings[f.key];
    if (f.kind === "secret") values[f.key] = "";
    else if (f.kind === "boolean") values[f.key] = v === undefined || v === null ? f.defaultValue === true : v === true;
    else values[f.key] = v === undefined || v === null ? "" : String(v);
  }
  return { values, folder: plugin.folder ?? "", clear: {} };
}

export type BuildResult =
  | { ok: true; body: ConfigurePluginBody }
  | { ok: false; errors: Record<string, string> };

function patternLabel(f: PluginField): string {
  // The schema's description usually names the expected form ("owner/name").
  return f.description && f.description.length <= 40 ? `Use the format ${f.description}.` : "Doesn't match the expected format.";
}

/**
 * The PUT body for a form. Plain settings: typed values; emptied ones that
 * were stored go as null, empty never-set ones are left out. Secrets: a typed
 * value sets, Clear sends null, an untouched (empty) field is left out so the
 * stored one stays — and the mask is never sent back as a value.
 */
export function buildConfigureBody(
  plugin: NestPlugin,
  draft: PluginDraft,
  opts: { enabled?: boolean } = {},
): BuildResult {
  const errors: Record<string, string> = {};
  const settings: Record<string, unknown> = {};
  for (const f of pluginFields(plugin)) {
    const raw = draft.values[f.key];
    const stored = plugin.settings[f.key];
    if (f.kind === "secret") {
      const typed = typeof raw === "string" ? raw.trim() : "";
      if (typed && typed !== SECRET_MASK) settings[f.key] = typed;
      else if (draft.clear[f.key] && secretIsSet(plugin, f.key)) settings[f.key] = null;
      const willBeSet = (typed && typed !== SECRET_MASK) || (secretIsSet(plugin, f.key) && !draft.clear[f.key]);
      if (f.required && !willBeSet) errors[f.key] = "Required";
      continue;
    }
    if (f.kind === "boolean") {
      if (raw !== (stored ?? f.defaultValue ?? false) || stored !== undefined) settings[f.key] = raw === true;
      continue;
    }
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s) {
      if (f.required) errors[f.key] = "Required";
      else if (stored !== undefined && stored !== null && stored !== "") settings[f.key] = null;
      continue;
    }
    if (f.kind === "integer" || f.kind === "number") {
      const n = Number(s);
      if (!Number.isFinite(n)) {
        errors[f.key] = "Must be a number";
        continue;
      }
      if (f.kind === "integer" && !Number.isInteger(n)) {
        errors[f.key] = "Must be a whole number";
        continue;
      }
      if (f.min !== undefined && n < f.min) {
        errors[f.key] = `Must be at least ${f.min}`;
        continue;
      }
      if (f.max !== undefined && n > f.max) {
        errors[f.key] = `Must be at most ${f.max}`;
        continue;
      }
      settings[f.key] = n;
      continue;
    }
    if (f.kind === "select" && f.options && !f.options.includes(s)) {
      errors[f.key] = `Pick one of: ${f.options.join(", ")}`;
      continue;
    }
    if (f.pattern) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(f.pattern);
      } catch {
        re = null; // A pattern the browser can't compile is the server's to check.
      }
      if (re && !re.test(s)) {
        errors[f.key] = patternLabel(f);
        continue;
      }
    }
    settings[f.key] = s;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const folder = draft.folder.trim().replace(/^\/+|\/+$/g, "");
  const body: ConfigurePluginBody = {
    ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
    folder: folder || null,
    settings,
  };
  return { ok: true, body };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 created · 1 updated · 12 unchanged", plus kept / failed when present. */
export function runCounts(run: Pick<PluginRun, "created" | "updated" | "unchanged" | "conflicts" | "failed">): string {
  const parts = [`${run.created} created`, `${run.updated} updated`, `${run.unchanged} unchanged`];
  if (run.conflicts.length) parts.push(`${run.conflicts.length} kept (edited here)`);
  if (run.failed.length) parts.push(`${run.failed.length} failed`);
  return parts.join(" · ");
}

/** Who started a run: the person for Run now, else the trigger as given. */
export function runTrigger(triggeredBy: string): string {
  return triggeredBy.startsWith("manual:") ? triggeredBy.slice("manual:".length) : triggeredBy;
}

export const RUN_STATUS_LABEL: Record<PluginRun["status"], string> = {
  clean: "Clean",
  conflicts: "Kept local edits",
  failed: "Failed",
};

/** A toast line for a finished run. */
export function runToast(displayName: string, run: PluginRun): string {
  if (run.status === "failed") return `${displayName}: the run failed${run.error ? ` — ${run.error}` : ""}`;
  const parts = [plural(run.created, "new document"), `${run.updated} updated`];
  if (run.conflicts.length) parts.push(`${run.conflicts.length} kept because they were edited here`);
  return `${displayName}: ${parts.join(", ")}`;
}
