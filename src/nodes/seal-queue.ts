/**
 * Seal queue — the deferred half of a document write.
 *
 * Writes run through the engine with `deferSeal` (see opContext): the user
 * waits for the document and its version entry only. The nest checkpoint and
 * the index update (context.yaml, INDEX.md) are recorded here as rows in
 * nest_write_jobs and done after the response, one `sealWrites` per batch, so
 * several writes that land together share one checkpoint and one index update.
 *
 * Rows outlive the process: whatever a restart cut off is picked up at boot
 * (resumeSeals). Until a row is sealed, the document is written and versioned
 * but not yet in a checkpoint or in context.yaml.
 */
import { sealWrites } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { nowExpr } from "../db/sql.js";

/** Wait after a failed seal before trying the nest again, doubling to a cap. */
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Consecutive failed drains per nest. */
const failures = new Map<string, number>();

/** Nests with a drain running, and whether more rows arrived meanwhile. */
const draining = new Map<string, { again: boolean }>();
/** Settles when a nest's drain stops; for tests and readers that need sealed state. */
const settled = new Map<string, Promise<void>>();

/** Record one deferred write and start sealing its nest. */
export async function enqueueSeal(nestId: string, nodeId: string, published: boolean): Promise<void> {
  const db = getDb();
  await db.run(
    `INSERT INTO nest_write_jobs (nest_id, node_id, published, created_at) VALUES (?, ?, ?, ${nowExpr(db)})`,
    [nestId, nodeId, published ? 1 : 0],
  );
  scheduleSeal(nestId);
}

/**
 * Seal every queued write of the nest. One drain per nest at a time; rows that
 * arrive while it runs are taken by the next round of the same drain.
 *
 * ponytail: per-process. Two instances on one nest could seal the same rows
 * twice (the vault lock keeps the chain intact; the second checkpoint repeats
 * the first). Claim rows with a lease column if the service scales out.
 */
export function scheduleSeal(nestId: string): Promise<void> {
  const running = draining.get(nestId);
  if (running) {
    running.again = true;
    return settled.get(nestId)!;
  }
  const state = { again: false };
  draining.set(nestId, state);
  const run = (async () => {
    try {
      do {
        state.again = false;
        await sealOnce(nestId);
      } while (state.again);
      failures.delete(nestId);
    } catch (err) {
      const n = (failures.get(nestId) ?? 0) + 1;
      failures.set(nestId, n);
      const wait = Math.min(RETRY_MS * 2 ** (n - 1), RETRY_MAX_MS);
      console.error(`[seal] failed, retrying in ${wait / 1000}s`, nestId, err);
      setTimeout(() => void scheduleSeal(nestId), wait).unref?.();
    } finally {
      draining.delete(nestId);
      settled.delete(nestId);
    }
  })();
  settled.set(nestId, run);
  return run;
}

/** Wait until the nest has nothing queued (or its drain failed). */
export async function sealsSettled(nestId: string): Promise<void> {
  await settled.get(nestId);
}

/** True when the nest has writes not yet in a checkpoint or the index. */
export async function hasPendingSeals(nestId: string): Promise<boolean> {
  return !!(await getDb().get("SELECT 1 FROM nest_write_jobs WHERE nest_id = ? LIMIT 1", [nestId]));
}

async function sealOnce(nestId: string): Promise<void> {
  const db = getDb();
  const rows = (await db.all(
    "SELECT id, node_id, published FROM nest_write_jobs WHERE nest_id = ? ORDER BY id",
    [nestId],
  )) as Array<{ id: number | string; node_id: string; published: number | string }>;
  if (!rows.length) return;
  const changed = [...new Set(rows.map((r) => r.node_id))];
  const published = [...new Set(rows.filter((r) => Number(r.published)).map((r) => r.node_id))];
  // Imported lazily: engine.ts enqueues through this module.
  const { engineCache } = await import("./engine.js");
  const { storage } = await engineCache.get(nestId);
  await sealWrites(storage, {
    changed,
    published,
    triggeredBy: published.length === 1 ? published[0] : `batch (${published.length} docs)`,
  });
  const last = Math.max(...rows.map((r) => Number(r.id)));
  await db.run("DELETE FROM nest_write_jobs WHERE nest_id = ? AND id <= ?", [nestId, last]);
}

/** Boot: seal whatever a previous process queued and never got to. */
export async function resumeSeals(): Promise<number> {
  const rows = (await getDb().all("SELECT DISTINCT nest_id FROM nest_write_jobs")) as Array<{
    nest_id: string;
  }>;
  for (const r of rows) void scheduleSeal(r.nest_id);
  return rows.length;
}
