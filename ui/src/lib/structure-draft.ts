/**
 * The Structure page's draft: edits to one nest's rule blocks, kept as the
 * same shape the server saves (`.context/config.yaml`'s `structure`,
 * `folders`, `templates`). Pure data shaping only — whether a rule is valid
 * is the server's call (POST /structure/check), never this file's.
 */
import type { StructureFolderConfig, StructureRules, StructureTemplateConfig } from "./api";

/** Name formats offered as presets; anything else is typed (a token pattern or /regex/). */
export const FILE_NAME_PRESETS = [
  { label: "Any name", value: "" },
  { label: "Title", value: "{slug}" },
  { label: "Date, then title", value: "{date}-{slug}" },
  { label: "Year, then title", value: "{yyyy}-{slug}" },
  { label: "Number, then title", value: "{n}-{slug}" },
] as const;

export const FOLDER_NAME_PRESETS = [
  { label: "Any name", value: "" },
  { label: "Lowercase words", value: "{slug}" },
  { label: "Year", value: "{yyyy}" },
  { label: "Date", value: "{date}" },
  { label: "Number", value: "{n}" },
] as const;

/** A folder rule without its empty fields, so the saved YAML stays what the owner set. */
export function cleanFolder(rule: StructureFolderConfig): StructureFolderConfig {
  const out: StructureFolderConfig = {};
  if (rule.description?.trim()) out.description = rule.description;
  if (rule.types && rule.types.length > 0) out.types = rule.types;
  if (rule.folder_name?.trim()) out.folder_name = rule.folder_name.trim();
  if (rule.file_name?.trim()) out.file_name = rule.file_name.trim();
  if (rule.template) out.template = rule.template;
  if (rule.required) out.required = true;
  if (rule.files && Object.keys(rule.files).length > 0) out.files = rule.files;
  return out;
}

export function folderRule(draft: StructureRules, pattern: string): StructureFolderConfig {
  return draft.folders?.[pattern] ?? {};
}

export function setFolder(draft: StructureRules, pattern: string, patch: Partial<StructureFolderConfig>): StructureRules {
  const next = cleanFolder({ ...folderRule(draft, pattern), ...patch });
  return { ...draft, folders: { ...draft.folders, [pattern]: next } };
}

/** Rename keeps the rule's place in the list; renaming onto another rule is refused (null). */
export function renameFolder(draft: StructureRules, from: string, to: string): StructureRules | null {
  if (from === to) return draft;
  if (!to || draft.folders?.[to] !== undefined) return null;
  const folders = Object.fromEntries(
    Object.entries(draft.folders ?? {}).map(([k, v]) => (k === from ? [to, v] : [k, v])),
  );
  return { ...draft, folders };
}

export function removeFolder(draft: StructureRules, pattern: string): StructureRules {
  const { [pattern]: _gone, ...folders } = draft.folders ?? {};
  return { ...draft, folders };
}

export function setTemplate(draft: StructureRules, name: string, patch: Partial<StructureTemplateConfig>): StructureRules {
  const t = { ...(draft.templates?.[name] ?? {}), ...patch };
  return { ...draft, templates: { ...draft.templates, [name]: t } };
}

/** Renaming a template follows every rule and required file that uses it. */
export function renameTemplate(draft: StructureRules, from: string, to: string): StructureRules | null {
  if (from === to) return draft;
  if (!to || draft.templates?.[to] !== undefined) return null;
  const templates = Object.fromEntries(
    Object.entries(draft.templates ?? {}).map(([k, v]) => (k === from ? [to, v] : [k, v])),
  );
  const folders = Object.fromEntries(
    Object.entries(draft.folders ?? {}).map(([k, rule]) => {
      if (!rule) return [k, rule];
      const files = rule.files
        ? Object.fromEntries(
            Object.entries(rule.files).map(([leaf, f]) => [leaf, f?.template === from ? { ...f, template: to } : f]),
          )
        : undefined;
      return [k, { ...rule, ...(rule.template === from ? { template: to } : {}), ...(files ? { files } : {}) }];
    }),
  );
  return { ...draft, templates, folders };
}

export function removeTemplate(draft: StructureRules, name: string): StructureRules {
  const { [name]: _gone, ...templates } = draft.templates ?? {};
  return { ...draft, templates };
}

export function setSwitch(draft: StructureRules, key: "enforce" | "closed", value: boolean): StructureRules {
  return { ...draft, structure: { ...draft.structure, [key]: value } };
}

/** Folder rules in display order: by path, so a rule's subfolder rules follow it. */
export function folderPatterns(draft: StructureRules): string[] {
  return Object.keys(draft.folders ?? {}).sort();
}

/** Same rules, ignoring key order and empty blocks — "are there unsaved changes?". */
export function sameRules(a: StructureRules, b: StructureRules): boolean {
  const norm = (r: StructureRules) =>
    JSON.stringify({
      enforce: !!r.structure?.enforce,
      closed: !!r.structure?.closed,
      folders: Object.entries(r.folders ?? {})
        .map(([k, v]) => [k, cleanFolder(v ?? {})])
        .sort(),
      templates: Object.entries(r.templates ?? {}).sort(),
    });
  return norm(a) === norm(b);
}

const FIELD_NAMES: Record<string, string> = {
  types: "what can be added",
  folder_name: "folder names",
  file_name: "file names",
  template: "template",
  required: "required",
  files: "required files",
  description: "description",
  body: "body",
  required_sections: "required sections",
  enforce: "Enforce rules",
  closed: "Closed structure",
};

/**
 * A rule key as the server names it (`folders.clients/{client}.file_name`) in
 * words people read: `Folder rule "clients/{client}" — file names`. Split, not
 * parsed with a regex: a pattern may itself hold dots.
 */
export function describeKey(key: string): string {
  const [kind, ...rest] = key.split(".");
  const last = rest[rest.length - 1];
  const field = rest.length > 1 && FIELD_NAMES[last] ? last : undefined;
  const name = (field ? rest.slice(0, -1) : rest).join(".");
  const what = field ? ` — ${FIELD_NAMES[field]}` : "";
  if (kind === "folders") return `Folder rule "${name}"${what}`;
  if (kind === "templates") return `Template "${name}"${what}`;
  if (kind === "structure") return FIELD_NAMES[rest[0]] ?? "Structure";
  return key;
}

/** A server message "key: text" with its key in words; anything else as it is. */
export function describeMessage(message: string): string {
  const at = message.indexOf(": ");
  if (at <= 0) return message;
  const key = message.slice(0, at);
  return /^(folders|templates|structure)\./.test(key) ? `${describeKey(key)}: ${message.slice(at + 2)}` : message;
}

/** How many distinct places a list of violations names — "12 problems in 9 places". */
export function placesOf(violations: Array<{ path: string }>): number {
  return new Set(violations.map((v) => v.path)).size;
}
