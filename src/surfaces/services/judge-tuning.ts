/**
 * A listener's own settings (Control room → Agents → Update). Blank = the
 * default. Stored in the listener agent's config: the model in `model`, name
 * and picture in `persona`, the rest under `surfaces_listener.judge`. Only what
 * the judge honours and what can't untie the listener from its binding.
 */
import { AppError } from "../../shared/errors.js";
import { avatarGlyph } from "../../metacognition/config.js";

export const DEFAULT_LISTENER_NAME = "Nest listener";

export interface JudgeTuning {
  name: string | null;
  avatar: string | null;
  /** A subset of the starter's folders; null = all of them. */
  folders: string[] | null;
  max_turns: number | null;
  max_items: number | null;
  model: string | null;
  max_output_tokens: number | null;
  temperature: number | null;
  timeout_seconds: number | null;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 1_500;
export const DEFAULT_TIMEOUT_SECONDS = 120;

const RANGES = {
  max_output_tokens: { min: 500, max: 8_000, integer: true },
  temperature: { min: 0, max: 1, integer: false },
  timeout_seconds: { min: 60, max: 300, integer: true },
  max_turns: { min: 2, max: 8, integer: true },
  max_items: { min: 1, max: 3, integer: true },
} as const;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'_-]{0,59}$/u;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The folders the starter gave this listener. */
export const starterFolders = (config: unknown): string[] => strings((config as { surfaces_listener?: { folders?: unknown } } | null)?.surfaces_listener?.folders);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;

const inRange = (k: keyof typeof RANGES, v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= RANGES[k].min && v <= RANGES[k].max && (!RANGES[k].integer || Number.isInteger(v));

/** What is stored, sanitised: anything out of range reads as unset. */
export function readJudgeTuning(config: unknown): JudgeTuning {
  const c = (config ?? {}) as { model?: unknown; persona?: { name?: unknown; avatar?: unknown }; surfaces_listener?: { judge?: Record<string, unknown> } };
  const j = c.surfaces_listener?.judge ?? {};
  const num = (k: keyof typeof RANGES) => (inRange(k, j[k]) ? (j[k] as number) : null);
  const name = c.persona?.name;
  return {
    name: typeof name === "string" && name !== DEFAULT_LISTENER_NAME ? name : null,
    avatar: typeof c.persona?.avatar === "string" ? c.persona.avatar : null,
    folders: Array.isArray(j.folders) && j.folders.length ? strings(j.folders) : null,
    max_turns: num("max_turns"),
    max_items: num("max_items"),
    model: typeof c.model === "string" && MODEL_RE.test(c.model) ? c.model : null,
    max_output_tokens: num("max_output_tokens"),
    temperature: num("temperature"),
    timeout_seconds: num("timeout_seconds"),
  };
}

/** A request's settings, checked. A key left out keeps its stored value; null clears it. */
export function parseJudgeTuning(body: unknown, current: JudgeTuning, allowedFolders: string[]): JudgeTuning {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(422, "judge must be an object");
  const next = { ...current };
  for (const [k, v] of Object.entries(body)) {
    if (k === "model") {
      if (v !== null && (typeof v !== "string" || !MODEL_RE.test(v))) throw new AppError(422, "judge.model must be a model name, or null for the default");
      next.model = v as string | null;
    } else if (k === "name") {
      if (v !== null && (typeof v !== "string" || !NAME_RE.test(v.trim()))) throw new AppError(422, "judge.name may use letters, numbers, spaces and . ' - _ (at most 60), or null for the default");
      next.name = typeof v === "string" ? v.trim() : null;
    } else if (k === "avatar") {
      next.avatar = v === null ? null : avatarGlyph(v);
    } else if (k === "folders") {
      if (v !== null && (!Array.isArray(v) || !v.length || !v.every((f) => typeof f === "string" && allowedFolders.includes(f))))
        throw new AppError(422, "judge.folders must be some of this listener's starter folders, or null for all of them");
      next.folders = v === null ? null : [...new Set(v as string[])];
    } else if (k in RANGES) {
      const rk = k as keyof typeof RANGES;
      const r = RANGES[rk];
      if (v !== null && !inRange(rk, v)) throw new AppError(422, `judge.${k} must be ${r.integer ? "a whole number" : "a number"} from ${r.min} to ${r.max}, or null for the default`);
      next[rk] = v as number | null;
    } else throw new AppError(422, `judge.${k} isn't a setting`);
  }
  return next;
}
