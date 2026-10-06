/**
 * Credentials are encrypted at rest.
 *
 * The Anthropic key, the other secret server settings, and a nest's Tool
 * environment used to sit in the database in the clear: anything that reached
 * the database — a dump, a replica, a backup, a console — reached them. These
 * tests assert on the ROW, not on the API: the value the database holds must
 * not be the value the admin typed, while every reader still sees plaintext.
 *
 * The master key is the generated one in the database unless SECRETS_KEY is
 * set; both paths are covered, including what happens when SECRETS_KEY is set
 * to the wrong thing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

async function row(key: string): Promise<{ value: string | null; env_at_write: string | null } | undefined> {
  const { getDb } = await import("../src/db/client.js");
  return (await getDb().get(
    "SELECT value, env_at_write FROM server_settings WHERE key = ?",
    [key],
  )) as any;
}

const OWNER = "owner@example.com";
const KEY_VALUE = "sk-ant-super-secret-value-9876";

let env: ReturnType<typeof setupTestEnv>;

beforeAll(() => {
  // Default path: no SECRETS_KEY, so the key is the one the server generates
  // into the database and reuses across restarts.
  delete process.env.SECRETS_KEY;
});
afterAll(() => {
  delete process.env.SECRETS_KEY;
});

describe("server settings — secrets at rest", () => {
  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
    env?.cleanup();
  });

  it("stores the Anthropic key as ciphertext, and reads it back in the clear", async () => {
    env = setupTestEnv();
    vi.doMock("../src/hootie/model.js", () => ({
      verifyModelKey: async () => null,
      streamAnswer: async function* () {},
      ModelRefusedError: class extends Error {},
    }));
    const app = await createTestApp("key", { ownerEmail: OWNER, features: ["byok"] });
    const admin = await registerUser(app, OWNER);

    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { anthropic_api_key: KEY_VALUE },
      admin.apiKey,
    );
    expect(res.status).toBe(200);

    // The row holds nothing a reader could use.
    const stored = await row("ANTHROPIC_API_KEY");
    expect(stored!.value).toBeTruthy();
    expect(stored!.value).not.toContain(KEY_VALUE);
    expect(stored!.value!.startsWith("enc.v1.")).toBe(true);

    // …while the server itself still has the real thing.
    expect(process.env.ANTHROPIC_API_KEY).toBe(KEY_VALUE);
    const after = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(after.data.anthropic_api_key_masked).toBe("••••9876");

    vi.doUnmock("../src/hootie/model.js");
  });

  it("encrypts the baseline column too — it holds the same secret", async () => {
    // env_at_write records the deploy-env value the write was baselined
    // against. For a credential that IS the credential, so leaving it in the
    // clear would hand over what the value column just protected.
    env = setupTestEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-deploy-env";
    // Fresh module graph so settings.ts captures the deploy baseline WITH the
    // env var set — it snapshots process.env on first use.
    vi.resetModules();
    const { persistSetting } = await import("../src/db/settings.js");
    const { initDb } = await import("../src/db/client.js");
    await initDb();
    await persistSetting("ANTHROPIC_API_KEY", "sk-ant-typed-in-the-ui");

    const stored = await row("ANTHROPIC_API_KEY");
    expect(stored!.env_at_write).not.toContain("sk-ant-from-the-deploy-env");
    expect(stored!.env_at_write!.startsWith("enc.v1.")).toBe(true);
  });

  it("seals every credential setting, including ones added after this shipped", async () => {
    // SES arrived in a later merge; a secret missing from the list stays
    // plaintext silently, so each one is pinned here.
    env = setupTestEnv();
    vi.resetModules();
    const { initDb } = await import("../src/db/client.js");
    const { persistSetting } = await import("../src/db/settings.js");
    await initDb();
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OIDC_CLIENT_SECRET",
      "MCP_SIGNING_SECRET",
      "SMTP_URL",
      "SLACK_WEBHOOK_URL",
      "MSTEAMS_WEBHOOK_URL",
      "SES_SECRET_ACCESS_KEY",
      "PROMPTOWL_KEY",
    ]) {
      await persistSetting(name, `secret-for-${name}`);
      const stored = (await row(name))!.value!;
      expect(stored, name).not.toContain(`secret-for-${name}`);
      expect(stored.startsWith("enc.v1."), name).toBe(true);
    }
  });

  it("a setting that is not a credential stays readable in the database", async () => {
    // Encryption is for secrets. Being able to see what a server is
    // configured to DO is worth keeping.
    env = setupTestEnv();
    vi.resetModules();
    const { persistSetting } = await import("../src/db/settings.js");
    const { initDb } = await import("../src/db/client.js");
    await initDb();
    await persistSetting("PUBLIC_BASE_URL", "https://nest.example");
    expect((await row("PUBLIC_BASE_URL"))!.value).toBe("https://nest.example");
  });

  it("reads a row written before encryption existed, and re-seals it on the next write", async () => {
    env = setupTestEnv();
    vi.resetModules();
    const { initDb, getDb } = await import("../src/db/client.js");
    const { loadServerSettings, persistSetting } = await import("../src/db/settings.js");
    await initDb();
    delete process.env.SMTP_URL;
    // A legacy plaintext row, exactly as the old code left it.
    await getDb().run(
      "INSERT INTO server_settings (key, value, env_at_write, updated_at) VALUES (?, ?, ?, ?)",
      ["SMTP_URL", "smtp://user:pw@mail.example", null, new Date().toISOString()],
    );
    await loadServerSettings();
    expect(process.env.SMTP_URL).toBe("smtp://user:pw@mail.example");

    await persistSetting("SMTP_URL", "smtp://user:pw2@mail.example");
    expect((await row("SMTP_URL"))!.value!.startsWith("enc.v1.")).toBe(true);
    delete process.env.SMTP_URL;
  });

  it("keeps the generated key in the database, so a restart still reads the value", async () => {
    // The point of storing the key here rather than on disk: a redeploy gets
    // a new filesystem but the same database, and every instance shares one
    // key with nothing to configure.
    env = setupTestEnv();
    vi.resetModules();
    const { initDb } = await import("../src/db/client.js");
    const { persistSetting } = await import("../src/db/settings.js");
    const { MASTER_KEY_SETTING } = await import("../src/shared/secret-box.js");
    await initDb();
    delete process.env.SMTP_URL;
    await persistSetting("SMTP_URL", "smtp://user:pw@mail.example");

    const keyRow = await row(MASTER_KEY_SETTING);
    expect(keyRow!.value).toMatch(/^[0-9a-f]{64}$/);

    // A "restart": fresh module graph, same database.
    vi.resetModules();
    const restarted = await import("../src/db/settings.js");
    await restarted.loadServerSettings();
    expect(process.env.SMTP_URL).toBe("smtp://user:pw@mail.example");
    // …and the key itself is not a setting: it must not land in the process
    // environment, where every child and bundle would see it.
    expect(process.env[MASTER_KEY_SETTING]).toBeUndefined();
    delete process.env.SMTP_URL;
  });

  it("reconciles a redeploy against the DECRYPTED baseline, not the ciphertext", async () => {
    // The Cloud Run story: the key is in the deploy env AND editable in the
    // UI. Precedence is decided by comparing the deploy value to the baseline
    // the row was written with — and that baseline is encrypted, so comparing
    // it raw would never match and every boot would look like "the operator
    // redeployed with a new value", silently throwing away the UI edit.
    env = setupTestEnv();
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-deploy-v1";
    const { initDb } = await import("../src/db/client.js");
    const { persistSetting } = await import("../src/db/settings.js");
    const { decryptSecret } = await import("../src/shared/secret-box.js");
    await initDb();
    // An admin replaces it from the Settings page.
    await persistSetting("ANTHROPIC_API_KEY", "sk-ant-typed-in-the-ui");

    // Redeploy #1 — same deploy env. The UI edit must survive.
    vi.resetModules();
    const boot1 = await import("../src/db/settings.js");
    await boot1.loadServerSettings();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-typed-in-the-ui");

    // Redeploy #2 — the operator ships a new key in the deploy config. That
    // is deliberate intent, so it wins and the row tracks forward to it…
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-deploy-v2";
    const boot2 = await import("../src/db/settings.js");
    await boot2.loadServerSettings();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-from-deploy-v2");

    // …re-sealed, not written back in the clear.
    const resynced = await row("ANTHROPIC_API_KEY");
    expect(resynced!.value!.startsWith("enc.v1.")).toBe(true);
    expect(await decryptSecret(resynced!.value!)).toBe("sk-ant-from-deploy-v2");

    // Redeploy #3 — same env again. Now the deploy value is what persists.
    vi.resetModules();
    const boot3 = await import("../src/db/settings.js");
    await boot3.loadServerSettings();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-from-deploy-v2");
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("a value this key can't open is dropped, not fatal", async () => {
    env = setupTestEnv();
    vi.resetModules();
    const { initDb } = await import("../src/db/client.js");
    const { persistSetting, loadServerSettings } = await import("../src/db/settings.js");
    await initDb();
    delete process.env.ANTHROPIC_API_KEY;
    await persistSetting("ANTHROPIC_API_KEY", "sk-ant-written-under-the-stored-key");

    // SECRETS_KEY now set to something the value was NOT written with — the
    // env var wins over the stored key, so this is what a wrong or rotated
    // one looks like.
    process.env.SECRETS_KEY = "a-completely-different-key";
    await expect(loadServerSettings()).resolves.toBeGreaterThan(0);
    // Unreadable is treated as unset: the admin re-enters it, the server runs.
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    delete process.env.SECRETS_KEY;
  });

  it("SECRETS_KEY from the environment wins over the stored key", async () => {
    env = setupTestEnv();
    vi.resetModules();
    process.env.SECRETS_KEY = "operator-supplied-key";
    const { initDb } = await import("../src/db/client.js");
    const { persistSetting } = await import("../src/db/settings.js");
    const { decryptSecret, MASTER_KEY_SETTING } = await import(
      "../src/shared/secret-box.js"
    );
    await initDb();
    await persistSetting("SLACK_WEBHOOK_URL", "https://hooks.example/T/B/xyz");

    // Nothing was generated — the operator's key was there to use.
    expect(await row(MASTER_KEY_SETTING)).toBeUndefined();
    const stored = (await row("SLACK_WEBHOOK_URL"))!.value!;
    expect(stored.startsWith("enc.v1.")).toBe(true);
    expect(await decryptSecret(stored)).toBe("https://hooks.example/T/B/xyz");
    delete process.env.SECRETS_KEY;
    delete process.env.SLACK_WEBHOOK_URL;
  });
});

describe("nest env store — secrets at rest", () => {
  let app: any;
  let alice: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let nestEnv: ReturnType<typeof setupTestEnv>;

  beforeAll(async () => {
    process.env.FEATURE_WORKFLOW_PLANE = "true";
    nestEnv = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@acme.com", "Alice");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Tools" }, alice.apiKey);
    nestId = nest.data.nest.id;
  });

  afterAll(() => {
    delete process.env.FEATURE_WORKFLOW_PLANE;
    nestEnv.cleanup();
  });

  it("stores a nest credential encrypted, and hands the runner the real value", async () => {
    const secret = "xoxb-nest-secret-12345";
    const put = await jsonRequest(
      app,
      "PUT",
      `/nests/${nestId}/env`,
      { key: "SLACK_TOKEN", value: secret },
      alice.apiKey,
    );
    expect(put.status).toBe(201);
    // Masked tail is still the real value's tail, so the admin recognises it.
    expect(put.data.value_masked).toBe("••••2345");

    const { getDb } = await import("../src/db/client.js");
    const stored = (await getDb().get(
      "SELECT value FROM nest_env WHERE nest_id = ? AND key = ?",
      [nestId, "SLACK_TOKEN"],
    )) as { value: string };
    expect(stored.value).not.toContain(secret);
    expect(stored.value.startsWith("enc.v1.")).toBe(true);

    // The listing decrypts for the mask…
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/env`, undefined, alice.apiKey);
    expect(list.data.env[0].value_masked).toBe("••••2345");
    expect(JSON.stringify(list.data)).not.toContain(secret);

    // …and the run bundle gets the value itself, not the ciphertext.
    const { envValues } = await import("../src/workflow/env-routes.js");
    expect((await envValues(nestId)).SLACK_TOKEN).toBe(secret);
  });
});
