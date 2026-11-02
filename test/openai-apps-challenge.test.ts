/**
 * OpenAI domain verification for publishing a ChatGPT app (our MCP server).
 * OpenAI fetches https://<domain>/.well-known/openai-apps-challenge and
 * expects the token it issued, as plain text. The token comes from
 * OPENAI_APPS_CHALLENGE (deploy env, or Settings → Agent OAuth, which
 * persists it like every other setting) — never from code.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

const PATH = "/.well-known/openai-apps-challenge";
const TOKEN = "fake-Challenge_token.0123456789abcdefABCDEF";
const OWNER_EMAIL = "owner@example.com";

let env: ReturnType<typeof setupTestEnv>;
beforeEach(() => {
  env = setupTestEnv();
  delete process.env.OPENAI_APPS_CHALLENGE;
});
afterEach(() => {
  delete process.env.OPENAI_APPS_CHALLENGE;
  env.cleanup();
});

const expectJson404 = async (res: Response) => {
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain("application/json");
  await expect(res.json()).resolves.toEqual({ error: "Not found" });
};

describe("GET /.well-known/openai-apps-challenge", () => {
  it("serves the configured token as plain text, with no auth", async () => {
    process.env.OPENAI_APPS_CHALLENGE = TOKEN;
    const app = await createTestApp("key");
    const res = await app.request(PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(TOKEN);
  });

  it("trims surrounding whitespace from the configured value", async () => {
    process.env.OPENAI_APPS_CHALLENGE = `  ${TOKEN}\n`;
    const app = await createTestApp("key");
    expect(await (await app.request(PATH)).text()).toBe(TOKEN);
  });

  it("does not depend on MCP OAuth being on", async () => {
    process.env.OPENAI_APPS_CHALLENGE = TOKEN;
    delete process.env.MCP_OAUTH_ENABLED;
    const app = await createTestApp("key");
    expect((await app.request(PATH)).status).toBe(200);
  });

  it.each([["unset", undefined], ["blank", "   "]])("404s like any unknown well-known path when %s", async (_l, v) => {
    if (v !== undefined) process.env.OPENAI_APPS_CHALLENGE = v;
    const app = await createTestApp("key");
    await expectJson404(await app.request(PATH));
  });

  it.each([
    ["markup", "<script>alert(1)</script>"],
    ["inner whitespace", "abc def"],
    ["a newline inside", "abc\ndef"],
    ["too long", "a".repeat(513)],
  ])("404s and echoes nothing when the value is malformed (%s)", async (_l, v) => {
    process.env.OPENAI_APPS_CHALLENGE = v;
    const app = await createTestApp("key");
    await expectJson404(await app.request(PATH));
  });

  it("leaves other well-known paths unchanged", async () => {
    process.env.OPENAI_APPS_CHALLENGE = TOKEN;
    const app = await createTestApp("key");
    await expectJson404(await app.request("/.well-known/openai-apps-challenge/extra"));
    await expectJson404(await app.request("/.well-known/something-else"));
  });
});

describe("Settings: openai_apps_challenge", () => {
  it("an admin sets it, it serves live, persists, and clearing it 404s again", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const before = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(before.data.openai_apps_challenge).toBe("");

    const set = await jsonRequest(app, "PATCH", "/admin/settings", { openai_apps_challenge: ` ${TOKEN} ` }, admin.apiKey);
    expect(set.status).toBe(200);
    expect(set.data.settings.openai_apps_challenge).toBe(TOKEN);
    expect(await (await app.request(PATH)).text()).toBe(TOKEN);

    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get("SELECT value FROM server_settings WHERE key = ?", ["OPENAI_APPS_CHALLENGE"])) as { value: string | null } | undefined;
    expect(row?.value).toBe(TOKEN);

    const clear = await jsonRequest(app, "PATCH", "/admin/settings", { openai_apps_challenge: "" }, admin.apiKey);
    expect(clear.status).toBe(200);
    await expectJson404(await app.request(PATH));
  });

  it("rejects a malformed token with a field error and applies nothing", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const res = await jsonRequest(app, "PATCH", "/admin/settings", { openai_apps_challenge: "has spaces <b>", logo_url: "https://cdn.example/l.png" }, admin.apiKey);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toContain("openai_apps_challenge");
    expect(process.env.OPENAI_APPS_CHALLENGE).toBeUndefined();
    await expectJson404(await app.request(PATH));
  });

  it("a non-admin cannot set it", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    await registerUser(app, OWNER_EMAIL);
    const stranger = await registerUser(app, "stranger@example.com");
    const res = await jsonRequest(app, "PATCH", "/admin/settings", { openai_apps_challenge: TOKEN }, stranger.apiKey);
    expect(res.status).toBe(403);
    await expectJson404(await app.request(PATH));
  });
});
