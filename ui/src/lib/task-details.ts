/**
 * The Stage / Priority / Due row on a task's own page. Pure helpers: which tag
 * group is the stage, what values to offer, and how a stage change rewrites the
 * tags. Nothing here names a particular team's stages — the nest's task rules
 * decide, and a nest with none falls back to the `stage:` tags its tasks use.
 */
import type { TaskRules } from "./api";

const bare = (t: string) => t.trim().replace(/^#+/, "").toLowerCase();
const nsOf = (t: string): string | null => {
  const b = bare(t);
  const i = b.indexOf(":");
  return i > 0 && i < b.length - 1 ? b.slice(0, i) : null;
};

/** The stage group: the namespace of the default stage, else the first
 *  one-per-task group, else `stage`. */
export function stageNamespace(rules?: Pick<TaskRules, "default_stage_tag" | "exclusive_namespaces">): string {
  return (
    (rules?.default_stage_tag ? nsOf(rules.default_stage_tag) : null) ??
    rules?.exclusive_namespaces?.[0] ??
    "stage"
  );
}

/** The task's current stage value (`in-review`), or undefined. */
export function currentStage(tags: readonly string[], ns: string): string | undefined {
  const t = tags.find((x) => nsOf(x) === ns);
  return t ? bare(t).slice(ns.length + 1) : undefined;
}

/**
 * Values to offer, in order: the nest's stage order when it has one, then any
 * other value tasks in the nest already use (alphabetical), then the task's own
 * value if it is neither — so the picker never hides where a task is.
 */
export function stageOptions(
  rules: Pick<TaskRules, "stage_order"> | undefined,
  nestTags: readonly (readonly string[])[],
  ns: string,
  current?: string,
): string[] {
  const out: string[] = [...(rules?.stage_order ?? [])];
  const seen = new Set(out);
  const used = new Set<string>();
  for (const tags of nestTags) for (const t of tags) if (nsOf(t) === ns) used.add(bare(t).slice(ns.length + 1));
  for (const v of [...used].sort()) if (!seen.has(v)) { out.push(v); seen.add(v); }
  if (current && !seen.has(current)) out.push(current);
  return out;
}

/** The tag list after moving a task to `value` (null clears it): every tag in
 *  the group is replaced by the one chosen, everything else — the ticket tag
 *  included — is kept as is. */
export function withStage(tags: readonly string[], ns: string, value: string | null): string[] {
  const rest = tags.filter((t) => nsOf(t) !== ns);
  return value ? [...rest, `${ns}:${value}`] : rest;
}

/** `in-review` → `In review`. */
export const stageLabel = (v: string): string => {
  const s = v.replace(/[-_]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : v;
};
