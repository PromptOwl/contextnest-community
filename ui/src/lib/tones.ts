/**
 * Colour for the small pills on board cards and the task page, plus the rule
 * for which tags a card leaves out. Pure, so it is testable without a browser.
 *
 * Tailwind only keeps class names it can see written out, so every tone is a
 * literal string here — nothing builds a class name from a variable.
 */

const TONES = {
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  rose: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  orange: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  green: "bg-green-500/15 text-green-700 dark:text-green-300",
  emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  teal: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  cyan: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  sky: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  indigo: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  pink: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
  slate: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
} as const;

type Tone = keyof typeof TONES;

/** Most urgent to least. Fewer levels sample this evenly, so any nest's scale
 *  runs red → grey: 4 levels are red / orange / sky / slate. */
const URGENCY: Tone[] = ["red", "orange", "amber", "sky", "slate"];

/** The tone for one priority level, by its position in the nest's list. */
export function priorityTone(levelKeys: readonly string[], key: string | undefined): string | undefined {
  const i = key ? levelKeys.indexOf(key) : -1;
  if (i === -1) return undefined;
  if (levelKeys.length <= 1) return TONES.red;
  return TONES[URGENCY[Math.round((i / (levelKeys.length - 1)) * (URGENCY.length - 1))]!];
}

const STAGES: Record<string, Tone> = {
  backlog: "slate",
  "in-progress": "sky",
  "in-review": "violet",
  "qa-staging": "amber",
  "ready-for-deployment": "teal",
  "qa-production": "emerald",
  done: "green",
  cancelled: "rose",
};

/** Hues for values with no fixed meaning. Red, amber and green are left out:
 *  on a task board they read as urgency and done. */
const HASHED: Tone[] = ["violet", "teal", "indigo", "pink", "cyan", "emerald"];

/** The solid dot for each tone: column headers carry the stage's colour. */
const DOTS: Record<Tone, string> = {
  red: "bg-red-500", rose: "bg-rose-500", orange: "bg-orange-500", amber: "bg-amber-500",
  green: "bg-green-500", emerald: "bg-emerald-500", teal: "bg-teal-500", cyan: "bg-cyan-500",
  sky: "bg-sky-500", indigo: "bg-indigo-500", violet: "bg-violet-500", pink: "bg-pink-500",
  slate: "bg-slate-400",
};

const slug = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, "-");

function hashIndex(value: string): number {
  let h = 0;
  for (const c of value) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % HASHED.length;
}

function hashTone(value: string): string {
  return TONES[HASHED[hashIndex(value)]!];
}

/** The tone for a stage value ("in-review"); an unknown stage gets a stable hue. */
export function stageTone(stage: string | undefined): string | undefined {
  if (!stage) return undefined;
  const v = slug(stage);
  const known = STAGES[v];
  return known ? TONES[known] : hashTone(v);
}

/** The tone for a namespaced tag (`surface:community`, `stage:done`). Flat tags
 *  have none: they stay neutral grey. */
export function tagPillTone(tag: string): string | undefined {
  const t = tag.replace(/^#/, "").trim().toLowerCase();
  const i = t.indexOf(":");
  if (i <= 0) return undefined;
  const ns = t.slice(0, i);
  const value = t.slice(i + 1);
  return ns === "stage" ? stageTone(value) : hashTone(value);
}

const bare = (t: string) => t.replace(/^#/, "").trim().toLowerCase();

/**
 * Tags nearly every card carries (`#projects`, `#engineering`), which tell the
 * reader nothing on a card. Judged over the whole board, not the filtered view,
 * so filtering to one repo doesn't make that repo's tag vanish. A board too
 * small to judge hides nothing.
 */
export function universalTags(
  tagLists: readonly (readonly string[])[],
  minCards = 5,
  share = 0.9,
): Set<string> {
  if (tagLists.length < minCards) return new Set();
  const counts = new Map<string, number>();
  for (const list of tagLists) {
    for (const t of new Set(list.map(bare))) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return new Set(
    [...counts].filter(([, c]) => c / tagLists.length >= share).map(([t]) => t),
  );
}

/** The dot for a stage column's key (`stage:in-review`); none for any other
 *  column, so only a stage board gets coloured headers. */
export function stageDot(columnKey: string): string | undefined {
  const k = columnKey.replace(/^#/, "").trim().toLowerCase();
  if (!k.startsWith("stage:")) return undefined;
  const v = slug(k.slice("stage:".length));
  return DOTS[STAGES[v] ?? HASHED[hashIndex(v)]!];
}
