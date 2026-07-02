/**
 * Slack connector: admin-configured incoming webhook; governance events
 * (review submitted/approved/rejected, nest shared) post fire-and-forget
 * messages. Empty/unset URL = connector off; failures never break the
 * underlying action.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/XXX";
const sent: Array<{ url: string; text: string }> = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.NOTIFY_DEBOUNCE_MS = "10"; // near-instant flush for tests
  process.env.SLACK_WEBHOOK_URL = WEBHOOK;
  vi.stubGlobal(
    "fetch",
    async (url: any, init?: any) => {
      const u = String(url);
      if (u === WEBHOOK) {
        sent.push({ url: u, text: JSON.parse(init.body).text });
        return new Response("ok", { status: 200 });
      }
      // Any other webhook URL simulates an outage; nothing in this suite may
      // touch the real network.
      if (u.includes("hooks.slack.com")) throw new Error("simulated outage");
      return realFetch(url, init);
    },
  );

  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Notify Nest" }, alice.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.SLACK_WEBHOOK_URL;
  env.cleanup();
});

// Notifications are fire-and-forget — give the microtask a beat to land.
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("Slack connector", () => {
  it("posts when a collaborator is added, prefixed with the nest name", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "bob@acme.com", permission: "write" },
      alice.apiKey,
    );
    await settle();
    const msg = sent.find((s) => s.text.includes("bob@acme.com"));
    expect(msg).toBeTruthy();
    expect(msg!.text).toContain("[Notify Nest]");
    expect(msg!.text).toContain("write");
  });

  it("does not post (and does not fail) when the webhook is unset", async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    const before = sent.length;
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "carol@acme.com", permission: "read" },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    await settle();
    expect(sent.length).toBe(before);
    process.env.SLACK_WEBHOOK_URL = WEBHOOK;
  });

  it("a failing webhook never breaks the governance action", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/DEAD/END";
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "dave@acme.com", permission: "read" },
      alice.apiKey,
    );
    // Stub throws for unknown URLs only if realFetch fails — either way the
    // API call itself must succeed.
    expect(res.status).toBe(201);
    process.env.SLACK_WEBHOOK_URL = WEBHOOK;
  });
});

describe("admin settings validation", () => {
  it("rejects a non-https webhook URL and accepts empty to disable", async () => {
    // alice isn't the license admin, so use open-mode app? No — key-mode
    // nest here; settings gate is license-admin. Validation is what we're
    // testing, so hit the endpoint as an admin via a fresh open-mode app.
    const openApp = await createTestApp("open");
    const bad = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      slack_webhook_url: "http://insecure.example.com/hook",
    });
    expect(bad.status).toBe(400);
    const clear = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      slack_webhook_url: "",
    });
    expect(clear.status).toBe(200);
    expect(clear.data.settings.slack_webhook_url).toBe("");
    process.env.SLACK_WEBHOOK_URL = WEBHOOK;
  });
});
