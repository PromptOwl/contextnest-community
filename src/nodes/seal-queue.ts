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
 *
 * Several instances can serve one nest (a scaled service, or the old and new
 * revision during a rollout). Only the holder of the nest's lease in
 * nest_seal_leases seals it; another instance with rows for that nest waits
 * for the lease instead. Any instance can seal any row: the seal reads the
 * document list from node_index and the histories from disk, not from this
 * process's caches.
 */
import { randomUUID } from "node:crypto";
import { sealWrites } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { nowExpr } from "../db/sql.js";

/** Wait after a failed seal before trying the nest again, doubling to a cap. */
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** How long a lease lasts without renewal: a crashed holder blocks its nests this long. */
const LEASE_MS = 60_000;
/** Renew this often while sealing, well inside LEASE_MS. */
const RENEW_MS = 20_000;
/** Poll for a lease another instance holds, or for its seal to finish. */
const WAIT_MS = 500;
/** A reader stops waiting for another instance's seal after this long. */
const READER_WAIT_MS = 10_000;

/** This process, as a lease owner. */
const owner = randomUUID();
/** Consecutive failed drains per nest. */
const failures = new Map<string, number>();
/** Nests with a drain running here. */
const draining = new Map<string, Promise<void>>();
/** Set on SIGTERM: finish the drain in hand, start no new one. */
let stopping = false;

/** Record one deferred write and start sealing its nest. */
export async function enqueueSeal(nestId: string, nodeId: string, published: boolean): Promise<void> {
  const db = getDb();
  await db.run(
    `INSERT INTO nest_write_jobs (nest_id, node_id, published, created_at) VALUES (?, ?, ?, ${nowExpr(db)})`,
    [nestId, nodeId, published ? 1 : 0],
  );
  void scheduleSeal(nestId);
}

/**
 * Seal every queued write of the nest, if this process can take its lease.
 * One drain per nest per process; it runs rounds until the queue is empty, so
 * rows any instance adds meanwhile are taken too. When another instance holds
 * the lease, this one checks back until the lease is free or the rows are gone.
 * Settles when this process's drain stops (or it could not take the lease).
 */
export function scheduleSeal(nestId: string): Promise<void> {
  const running = draining.get(nestId);
  if (running) return running;
  if (stopping) return Promise.resolve();
  const run = (async () => {
    if (!(await acquireLease(nestId))) {
      // Another instance is sealing. Its drain takes rows added since, but
      // one added after its last round would wait for the next write; check back.
      setTimeout(() => {
        void hasPendingSeals(nestId).then((p) => {
          if (p) void scheduleSeal(nestId);
        });
      }, WAIT_MS).unref?.();
      return;
    }
    const renew = setInterval(() => void acquireLease(nestId), RENEW_MS);
    renew.unref?.();
    try {
      while (!stopping && (await sealOnce(nestId)));
      failures.delete(nestId);
    } catch (err) {
      const n = (failures.get(nestId) ?? 0) + 1;
      failures.set(nestId, n);
      const wait = Math.min(RETRY_MS * 2 ** (n - 1), RETRY_MAX_MS);
      console.error(`[seal] failed, retrying in ${wait / 1000}s`, nestId, err);
      setTimeout(() => void scheduleSeal(nestId), wait).unref?.();
    } finally {
      clearInterval(renew);
      await releaseLease(nestId);
    }
  })().finally(() => draining.delete(nestId));
  draining.set(nestId, run);
  return run;
}

/** Wait for this process's drain of the nest, if any. */
export async function sealsSettled(nestId: string): Promise<void> {
  await draining.get(nestId);
}

/**
 * Read-your-writes for readers of sealed state (context.yaml, checkpoints):
 * seal the nest's queued writes, or wait while another instance does. Gives up
 * after READER_WAIT_MS and reads what is there.
 */
export async function sealedFor(nestId: string): Promise<void> {
  const deadline = Date.now() + READER_WAIT_MS;
  while (await hasPendingSeals(nestId)) {
    await scheduleSeal(nestId);
    if (!(await hasPendingSeals(nestId)) || Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, WAIT_MS));
  }
}

/** True when the nest has writes not yet in a checkpoint or the index. */
export async function hasPendingSeals(nestId: string): Promise<boolean> {
  return !!(await getDb().get("SELECT 1 FROM nest_write_jobs WHERE nest_id = ? LIMIT 1", [nestId]));
}

/**
 * Take or renew the nest's lease: one statement, so two instances cannot both
 * win. It goes to this process when nobody holds it, the holder's lease ran
 * out, or this process already holds it.
 */
async function acquireLease(nestId: string): Promise<boolean> {
  const db = getDb();
  const now = Date.now();
  await db.run(
    `INSERT INTO nest_seal_leases (nest_id, owner, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (nest_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
     WHERE nest_seal_leases.expires_at < ? OR nest_seal_leases.owner = ?`,
    [nestId, owner, now + LEASE_MS, now, owner],
  );
  const row = (await db.get("SELECT owner FROM nest_seal_leases WHERE nest_id = ?", [nestId])) as
    | { owner: string }
    | undefined;
  return row?.owner === owner;
}

async function releaseLease(nestId: string): Promise<void> {
  try {
    await getDb().run("DELETE FROM nest_seal_leases WHERE nest_id = ? AND owner = ?", [nestId, owner]);
  } catch (err) {
    // Expires on its own within LEASE_MS.
    console.error("[seal] could not release lease", nestId, err);
  }
}

/** Seal one batch; false when the queue was empty. */
async function sealOnce(nestId: string): Promise<boolean> {
  const db = getDb();
  const rows = (await db.all(
    "SELECT id, node_id, published FROM nest_write_jobs WHERE nest_id = ? ORDER BY id",
    [nestId],
  )) as Array<{ id: number | string; node_id: string; published: number | string }>;
  if (!rows.length) return false;
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
  return true;
}

/** Boot: seal whatever a previous process queued and never got to. */
export async function resumeSeals(): Promise<number> {
  const rows = (await getDb().all("SELECT DISTINCT nest_id FROM nest_write_jobs")) as Array<{
    nest_id: string;
  }>;
  for (const r of rows) void scheduleSeal(r.nest_id);
  return rows.length;
}

/**
 * A nest about to be deleted: forget its queued writes and wait out a seal in
 * progress here. (One running on another instance fails on the missing folder
 * and finds no rows on retry.)
 */
export async function dropSeals(nestId: string): Promise<void> {
  await getDb().run("DELETE FROM nest_write_jobs WHERE nest_id = ?", [nestId]);
  await draining.get(nestId);
}

/**
 * Shutdown (SIGTERM): start no new drain and wait for the ones running, so
 * their leases are released; whatever is left is sealed by the next instance.
 */
export async function stopSeals(): Promise<void> {
  stopping = true;
  await Promise.allSettled(draining.values());
}
