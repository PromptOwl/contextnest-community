/**
 * Per-import I/O accounting: how many times each storage method (and the DB
 * index hooks) ran during one import call, and for how long. Logged as one
 * line so a slow import on a network mount shows which operation dominates.
 *
 * Times overlap: calls run concurrently, and a storage method calling another
 * counts both. Read it per operation, not as a sum.
 */
type Stat = { n: number; ms: number };
const active = new Map<string, Map<string, Stat>>();

function record(nestId: string, op: string, ms: number): void {
  const stats = active.get(nestId);
  if (!stats) return;
  const s = stats.get(op) ?? { n: 0, ms: 0 };
  s.n++;
  s.ms += ms;
  stats.set(op, s);
}

/** Time `fn` under `op` while an import on `nestId` is being recorded. */
export async function timed<T>(nestId: string, op: string, fn: () => Promise<T>): Promise<T> {
  if (!active.has(nestId)) return fn();
  const t = performance.now();
  try {
    return await fn();
  } finally {
    record(nestId, op, performance.now() - t);
  }
}

/** Count every method call on `storage` under its name while a recording is active. */
export function instrumentStorage<S extends object>(nestId: string, storage: S): S {
  const names = new Set<string>();
  for (let p = Object.getPrototypeOf(storage); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(p))) {
      if (name !== "constructor" && typeof d.value === "function") names.add(name);
    }
  }
  const proto = Object.getPrototypeOf(storage);
  for (const name of names) {
    // Resolved per call, not bound once, so a later patch of the prototype applies.
    const fn = (...args: unknown[]) => proto[name].apply(storage, args);
    (storage as any)[name] = (...args: unknown[]) => {
      if (!active.has(nestId)) return fn(...args);
      const t = performance.now();
      const out = fn(...args);
      // Sync methods stay sync; async ones are timed to settlement.
      if (out && typeof out.then === "function") {
        return out.finally(() => record(nestId, name, performance.now() - t));
      }
      record(nestId, name, performance.now() - t);
      return out;
    };
  }
  return storage;
}

/** Record I/O for `fn` on `nestId` and log one summary line labelled `label`. */
export async function withIoStats<T>(
  nestId: string,
  label: string,
  fn: () => Promise<T>,
  tag: "import" | "write" = "import",
): Promise<T> {
  // A nested recording (finalize inside a one-shot import, a write inside
  // another write on the same nest) folds into the outer one.
  if (active.has(nestId)) return fn();
  active.set(nestId, new Map());
  const t = performance.now();
  // Imports run for seconds to minutes, single writes for milliseconds.
  const fmt = (ms: number) => (tag === "import" ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
  try {
    return await fn();
  } finally {
    const stats = [...active.get(nestId)!].sort((a, b) => b[1].ms - a[1].ms);
    active.delete(nestId);
    // A write touches dozens of pure path helpers; under 1ms they are noise.
    const shown = tag === "write" ? stats.filter(([, s]) => s.ms >= 1) : stats;
    const parts = shown.map(([op, s]) => `${op} ${s.n}x/${fmt(s.ms)}`);
    console.log(`[${tag}] io ${label}: nest=${nestId} total=${fmt(performance.now() - t)} ${parts.join(", ")}`);
  }
}

/** `withIoStats` for one document write (create, update, delete, move, approve). */
export function withWriteStats<T>(nestId: string, label: string, fn: () => Promise<T>): Promise<T> {
  return withIoStats(nestId, label, fn, "write");
}
