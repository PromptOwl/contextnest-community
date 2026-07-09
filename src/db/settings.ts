import { getDb } from "./client.js";
import { insertOrReplace, nowExpr } from "./sql.js";

/**
 * Durable, DB-backed store for runtime-mutable server settings — the values the
 * admin edits from the Settings page, plus the installed license key.
 *
 * Why not a .env file? The previous mechanism wrote these to a dotenv file under
 * DATA_ROOT. On Cloud Run the container filesystem is ephemeral, so every
 * rebuild/redeploy wiped the file; and even between rebuilds, horizontally
 * scaled instances each have their own filesystem, so a change made on one
 * instance never reached the others. The database (Cloud SQL in production) is
 * the one store that is both durable AND shared, so these settings live there.
 *
 * Precedence between the deploy environment and a stored UI edit is resolved
 * against a per-row baseline (`env_at_write` = the deploy-env value that was in
 * effect when the row was written):
 *   - deploy env CHANGED since that write → the operator re-deployed with a new
 *     value on purpose → the env wins and the row is re-synced to it.
 *   - deploy env UNCHANGED                → the stored UI edit wins.
 * So an operator can override any setting from the deploy config, while a UI
 * edit survives an identical rebuild.
 */

// Snapshot of the deploy environment (Cloud Run env + .env files), captured at
// boot BEFORE any DB value is overlaid onto process.env. Every write records
// this baseline and every reconcile compares against it. Re-captured on each
// loadServerSettings() call, so a fresh process (i.e. a redeploy) re-baselines.
let deployBaseline: Record<string, string | undefined> | null = null;

/** Treat undefined (unset env) and null (SQL NULL) as the same "absent". */
function norm(v: string | null | undefined): string | null {
  return v === undefined || v === null ? null : v;
}

function baseline(): Record<string, string | undefined> {
  // Lazily capture if a write happens before boot's loadServerSettings (e.g. a
  // unit test). In the real server loadServerSettings runs first at startup.
  if (!deployBaseline) deployBaseline = { ...process.env };
  return deployBaseline;
}

/**
 * Persist one setting durably. `value=null` writes a tombstone (the setting is
 * explicitly cleared and falls back to its code default) rather than deleting
 * the row — a deleted row would read as "never set" and let the deploy env
 * resurrect the value on the next boot.
 *
 * Records the deploy-env baseline for this key so a future reconcile can tell
 * whether a later redeploy changed the env.
 */
export async function persistSetting(
  name: string,
  value: string | null,
): Promise<void> {
  const db = getDb();
  const envAtWrite = norm(baseline()[name]);
  await db.run(
    insertOrReplace(
      db,
      `INSERT INTO server_settings (key, value, env_at_write, updated_at)
       VALUES (?, ?, ?, ${nowExpr(db)})`,
      ["key"],
      `value = excluded.value, env_at_write = excluded.env_at_write, updated_at = ${nowExpr(db)}`,
    ),
    [name, value, envAtWrite],
  );
}

/**
 * Boot step: overlay durable settings onto process.env so the config getters
 * (which read process.env) see them. MUST run after initDb() and BEFORE
 * anything reads config — in particular before validateLicense(), since the
 * installed license key is one of these settings.
 *
 * Re-captures the deploy baseline for this process, then reconciles each stored
 * row against it (see the precedence rule above). Returns the number of rows
 * applied.
 */
export async function loadServerSettings(): Promise<number> {
  // Re-capture the deploy baseline for THIS process/boot before overlaying.
  deployBaseline = { ...process.env };
  const base = deployBaseline;

  const db = getDb();
  const rows = (await db.all(
    "SELECT key, value, env_at_write FROM server_settings",
  )) as Array<{
    key: string;
    value: string | null;
    env_at_write: string | null;
  }>;

  let applied = 0;
  for (const row of rows) {
    const envVal = norm(base[row.key]);
    if (envVal !== norm(row.env_at_write)) {
      // Deploy env changed since this row was written → operator intent wins.
      // Re-sync the row to the new env value (or a tombstone if the env var was
      // removed) so the baseline tracks forward.
      await persistSetting(row.key, envVal);
      if (envVal === null) delete process.env[row.key];
      else process.env[row.key] = envVal;
    } else {
      // Deploy env unchanged → the stored UI edit wins.
      if (row.value === null) delete process.env[row.key];
      else process.env[row.key] = row.value;
    }
    applied++;
  }
  return applied;
}
