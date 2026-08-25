/**
 * DB-backed server settings + env/DB reconcile precedence (src/db/settings.ts).
 *
 * These settings used to be written to a .env file under DATA_ROOT, which Cloud
 * Run wiped on every rebuild and never shared across instances. They now live
 * in the server_settings table and are overlaid onto process.env at boot.
 *
 * The interesting behaviour is precedence between the deploy environment and a
 * stored UI edit, resolved against a per-row baseline (env_at_write):
 *   - rebuild with the SAME deploy env → the stored UI edit wins.
 *   - rebuild with a CHANGED deploy env → the operator's new env wins + resync.
 *
 * A "reboot" is simulated by resetting the module graph (so settings.ts loses
 * its in-memory baseline, exactly like a fresh process) while the SQLite file on
 * disk persists — same durable DB, fresh process memory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestEnv } from "./helpers";

// Env keys these tests mutate — cleared between cases so leakage can't mask a bug.
const TOUCHED = ["LOGO_URL", "FEATURE_WORKFLOW_PLANE"];

let env: ReturnType<typeof setupTestEnv>;

beforeEach(() => {
  env = setupTestEnv();
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
  env.cleanup();
});

/** Simulate a fresh process boot against the same on-disk DB. */
async function boot() {
  vi.resetModules();
  const client = await import("../src/db/client.js");
  await client.resetDb();
  await client.initDb();
  const settings = await import("../src/db/settings.js");
  return { client, settings };
}

describe("server settings — env/DB reconcile", () => {
  it("case 1: rebuild with the same env keeps the UI edit", async () => {
    // Deploy env has no LOGO_URL; the admin sets it from the Settings page.
    let { settings } = await boot();
    await settings.loadServerSettings(); // no rows yet
    await settings.persistSetting("LOGO_URL", "https://ui.example/logo.png");

    // Rebuild with the SAME deploy env (LOGO_URL still unset in the container).
    delete process.env.LOGO_URL;
    ({ settings } = await boot());
    const applied = await settings.loadServerSettings();

    expect(applied).toBe(1);
    expect(process.env.LOGO_URL).toBe("https://ui.example/logo.png");
  });

  it("case 2: rebuild with a new env value overrides the UI edit and resyncs the DB", async () => {
    let boot2 = await boot();
    await boot2.settings.loadServerSettings();
    await boot2.settings.persistSetting("LOGO_URL", "https://ui.example/logo.png");

    // Operator redeploys with LOGO_URL now set in the container env.
    process.env.LOGO_URL = "https://deploy.example/logo.png";
    boot2 = await boot();
    await boot2.settings.loadServerSettings();

    // Env wins.
    expect(process.env.LOGO_URL).toBe("https://deploy.example/logo.png");

    // DB re-synced to the deploy value + baseline, so a later identical rebuild
    // is stable (env === env_at_write → no further override).
    const row = (await boot2.client.getDb().get(
      "SELECT value, env_at_write FROM server_settings WHERE key = ?",
      ["LOGO_URL"],
    )) as { value: string | null; env_at_write: string | null };
    expect(row.value).toBe("https://deploy.example/logo.png");
    expect(row.env_at_write).toBe("https://deploy.example/logo.png");
  });

  it("a cleared setting is tombstoned so the env can't resurrect it", async () => {
    let { settings } = await boot();
    await settings.loadServerSettings();
    await settings.persistSetting("FEATURE_WORKFLOW_PLANE", "true");
    // Admin turns it back off — a tombstone (value NULL), not a row delete.
    await settings.persistSetting("FEATURE_WORKFLOW_PLANE", null);

    delete process.env.FEATURE_WORKFLOW_PLANE;
    ({ settings } = await boot());
    await settings.loadServerSettings();

    // Falls back to its code default (unset), NOT resurrected from the env.
    expect(process.env.FEATURE_WORKFLOW_PLANE).toBeUndefined();
  });

  it("a UI-only setting (never in the env) stays stable across identical rebuilds", async () => {
    let { settings } = await boot();
    await settings.loadServerSettings();
    await settings.persistSetting("LOGO_URL", "https://ui.example/a.png");

    // Two more identical rebuilds — the value must not drift.
    for (let i = 0; i < 2; i++) {
      delete process.env.LOGO_URL;
      ({ settings } = await boot());
      await settings.loadServerSettings();
      expect(process.env.LOGO_URL).toBe("https://ui.example/a.png");
    }
  });
});
