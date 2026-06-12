/**
 * Saved filters — pure, framework-free so it's unit-testable in the node test
 * env. Captures a snapshot of the Documents filter bar (search, status, tags,
 * author, date preset) under a name. NestView owns the localStorage I/O; this
 * module owns the data shape, (de)serialization, and the date-preset math.
 */

export type DatePreset = "any" | "7d" | "30d" | "90d" | "1y";

export interface SavedFilter {
  name: string;
  search?: string;
  status?: string;
  tags?: string[];
  author?: string;
  datePreset?: DatePreset;
}

const PRESET_DAYS: Record<Exclude<DatePreset, "any">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

/**
 * Epoch-ms threshold for a date preset, given the caller's "now" (passed in so
 * this stays clock-free). Returns undefined for "any" — i.e. no date filter.
 */
export function datePresetToEpoch(
  preset: DatePreset | undefined,
  nowMs: number,
): number | undefined {
  if (!preset || preset === "any") return undefined;
  return nowMs - PRESET_DAYS[preset] * 24 * 60 * 60 * 1000;
}

/** Insert `filter`, replacing any existing one with the same name (case-insensitive). */
export function upsertFilter(
  list: SavedFilter[],
  filter: SavedFilter,
): SavedFilter[] {
  const name = filter.name.toLowerCase();
  return [...list.filter((f) => f.name.toLowerCase() !== name), filter];
}

export function removeFilter(list: SavedFilter[], name: string): SavedFilter[] {
  const lower = name.toLowerCase();
  return list.filter((f) => f.name.toLowerCase() !== lower);
}

/** Defensive parse of stored JSON → only well-formed, named entries survive. */
export function parseSavedFilters(json: string | null): SavedFilter[] {
  if (!json) return [];
  try {
    const data = JSON.parse(json);
    if (!Array.isArray(data)) return [];
    return data
      .filter((f) => f && typeof f.name === "string" && f.name.trim())
      .map((f) => ({
        name: String(f.name),
        search: typeof f.search === "string" ? f.search : undefined,
        status: typeof f.status === "string" ? f.status : undefined,
        tags: Array.isArray(f.tags)
          ? f.tags.filter((t: unknown) => typeof t === "string")
          : undefined,
        author: typeof f.author === "string" ? f.author : undefined,
        datePreset:
          typeof f.datePreset === "string"
            ? (f.datePreset as DatePreset)
            : undefined,
      }));
  } catch {
    return [];
  }
}

export function serializeSavedFilters(list: SavedFilter[]): string {
  return JSON.stringify(list);
}
