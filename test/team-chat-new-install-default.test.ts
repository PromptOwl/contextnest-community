/**
 * Team chat is on by default for a NEW installation, and only for one.
 *
 * A new installation is a database with no users, no nests and no stored
 * server settings at boot. On that boot `seedNewInstallDefaults()` writes the
 * same server_settings rows a superadmin's Settings toggle writes
 * (TEAM_CHAT_ENABLED + its alias EXPERIMENTAL_AGENT_STREAM), before the boot
 * overlay. Existing servers are never touched; after the seed, the existing
 * precedence rules (tombstones, deploy env wins on change) apply unchanged.
 *
 * Examples EX-1..EX-6 are on the Engineering Ops ticket
 * "[Community Nest] Team chat is on by default for new installations".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestEnv } from "./helpers";

const TOUCHED = ["TEAM_CHAT_ENABLED", "EXPERIMENTAL_AGENT_STREAM"];

let env: ReturnType<typeof setupTestEnv>;

beforeEach(() => {
  env = setupTestEnv();
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
  env.cleanup();
});

/** A fresh process boot against the same on-disk DB, in index.ts order. */
async function boot() {
  vi.resetModules();
  const client = await import("../src/db/client.js");
  await client.resetDb();
  await client.initDb();
  const settings = await import("../src/db/settings.js");
  const seeded = await settings.seedNewInstallDefaults();
  await settings.loadServerSettings();
  const { config } = await import("../src/config.js");
  return { client, settings, seeded, chatOn: config.TEAM_CHAT_ENABLED };
}

async function addUser(client: typeof import("../src/db/client.js")) {
  await client.getDb().run(
    "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
    ["u-existing", "ed@example.com", "Ed", "x"],
  );
}

describe("team chat default for new installations", () => {
  it("EX-1: an empty database boots with team chat on", async () => {
    const { seeded, chatOn } = await boot();
    expect(seeded).toBe(true);
    expect(chatOn).toBe(true);
    expect(process.env.EXPERIMENTAL_AGENT_STREAM).toBe("true");
  });

  it("EX-2: an existing server that never set chat stays off", async () => {
    // First boot of an OLD version: no seed ran, a user signed up.
    vi.resetModules();
    const client = await import("../src/db/client.js");
    await client.resetDb();
    await client.initDb();
    await addUser(client);

    const { seeded, chatOn } = await boot();
    expect(seeded).toBe(false);
    expect(chatOn).toBe(false);
  });

  it("EX-2b: an existing server with only stored settings is not a new install", async () => {
    vi.resetModules();
    const client = await import("../src/db/client.js");
    await client.resetDb();
    await client.initDb();
    const settings = await import("../src/db/settings.js");
    await settings.persistSetting("LOGO_URL", "https://ui.example/logo.png");

    const { seeded, chatOn } = await boot();
    expect(seeded).toBe(false);
    expect(chatOn).toBe(false);
    delete process.env.LOGO_URL;
  });

  it("EX-4: on a seeded install, a superadmin turning chat off survives a restart", async () => {
    let { settings, chatOn } = await boot();
    expect(chatOn).toBe(true);
    // What PATCH /admin/settings { team_chat_enabled: false } writes.
    await settings.persistSetting("TEAM_CHAT_ENABLED", null);
    await settings.persistSetting("EXPERIMENTAL_AGENT_STREAM", null);

    for (const k of TOUCHED) delete process.env[k];
    ({ chatOn } = await boot());
    expect(chatOn).toBe(false);
  });

  it("EX-5: a deploy env that says false wins on a new install", async () => {
    process.env.TEAM_CHAT_ENABLED = "false";
    const { chatOn } = await boot();
    expect(chatOn).toBe(false);
  });

  it("EX-6: a second boot does not seed again", async () => {
    const first = await boot();
    expect(first.seeded).toBe(true);
    for (const k of TOUCHED) delete process.env[k];
    const second = await boot();
    expect(second.seeded).toBe(false);
    expect(second.chatOn).toBe(true);
  });
});
