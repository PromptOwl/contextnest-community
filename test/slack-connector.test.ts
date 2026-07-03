/**
 * Slack connector: admin-configured incoming webhook; governance events
 * (review submitted/approved/rejected, nest shared) post fire-and-forget
 * messages. Empty/unset URL = connector off; failures never break the
 * underlying action.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
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

// The review lifecycle events (submit / approve / reject) each fire a Slack
// message, and those messages carry a user-controlled note plus the document's
// title + folder. This block is self-contained (own fetch stub + webhook) so it
// doesn't depend on the first block's beforeAll/afterAll ordering.
describe("Slack connector — review lifecycle + mrkdwn escaping", () => {
  let lenv: ReturnType<typeof setupTestEnv>;
  let lapp: any;
  let admin: { apiKey: string };
  let dev: { apiKey: string };
  let jane: { apiKey: string };
  let lnestId: string;

  const LWEBHOOK = "https://hooks.slack.com/services/T111/B111/YYY";
  const lsent: string[] = [];
  const realFetch = globalThis.fetch;
  const settle = () => new Promise((r) => setTimeout(r, 50));

  beforeAll(async () => {
    process.env.SLACK_WEBHOOK_URL = LWEBHOOK;
    vi.stubGlobal("fetch", async (url: any, init?: any) => {
      const u = String(url);
      if (u === LWEBHOOK) {
        lsent.push(JSON.parse(init.body).text);
        return new Response("ok", { status: 200 });
      }
      if (u.includes("hooks.slack.com")) throw new Error("simulated outage");
      return realFetch(url, init);
    });

    lenv = setupTestEnv();
    lapp = await createTestApp("key", { superAdmins: ["lead@acme.com"] });
    admin = await registerUser(lapp, "lead@acme.com", "Lead");
    dev = await registerUser(lapp, "dev@acme.com", "Dev");
    jane = await registerUser(lapp, "jane@acme.com", "Jane");

    const nest = await jsonRequest(lapp, "POST", "/nests", { name: "Governed" }, admin.apiKey);
    lnestId = nest.data.nest.id;

    // jane reviews (can approve) anything tagged #architecture.
    const nestPath = join(lenv.dataDir, "nests", lnestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `version: 1
tags:
  #architecture:
    - email: jane@acme.com, role: reviewer, can_approve: true
`,
    );
    for (const email of ["dev@acme.com", "jane@acme.com"]) {
      await jsonRequest(lapp, "POST", `/nests/${lnestId}/collaborators`,
        { email, permission: "write" }, admin.apiKey);
    }
    await jsonRequest(lapp, "POST", `/nests/${lnestId}/stewards/sync`, {}, admin.apiKey);
  }, 30000);

  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env.SLACK_WEBHOOK_URL;
    lenv.cleanup();
  });

  // Create a draft doc inside the `api` folder, tagged so jane resolves as a
  // reviewer. Returns the node id ("nodes/api/<slug>").
  async function draft(title: string): Promise<string> {
    const res = await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes`,
      { title, content: "# body", folder: "api", tags: ["architecture"] }, dev.apiKey);
    expect(res.status).toBe(201);
    return res.data.node.id;
  }

  it("submit posts the document title + folder, and escapes the note", async () => {
    const id = await draft("Rate Limits");
    expect(id).toBe("nodes/api/rate-limits");

    lsent.length = 0;
    const res = await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes/${id}/submit-review`,
      { note: "<!channel> please review", priority: "high" }, dev.apiKey);
    expect(res.status).toBe(201);
    await settle();

    const msg = lsent.find((t) => t.includes("Rate Limits"));
    expect(msg).toBeTruthy();
    expect(msg).toContain(":memo:");
    // Title, not the raw node path; folder surfaced so a reviewer has context.
    expect(msg).toContain("Rate Limits (in api)");
    expect(msg).not.toContain("nodes/api/rate-limits");
    // The <!channel> mass-ping is neutralized, not passed through raw.
    expect(msg).toContain("&lt;!channel&gt;");
    expect(msg).not.toContain("<!channel>");
  });

  it("approve posts a message with the document title", async () => {
    const id = await draft("Approve Me");
    await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes/${id}/submit-review`, {}, dev.apiKey);
    lsent.length = 0;
    const res = await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes/${id}/approve`,
      { note: "lgtm" }, jane.apiKey);
    expect(res.status).toBe(200);
    await settle();
    const msg = lsent.find((t) => t.includes("Approve Me"));
    expect(msg).toBeTruthy();
    expect(msg).toContain(":white_check_mark:");
    expect(msg).toContain("Approve Me (in api)");
  });

  it("reject posts a message and escapes the rejection note", async () => {
    const id = await draft("Reject Me");
    await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes/${id}/submit-review`, {}, dev.apiKey);
    lsent.length = 0;
    const res = await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes/${id}/reject`,
      { note: "<!here> missing section" }, jane.apiKey);
    expect(res.status).toBe(200);
    await settle();
    const msg = lsent.find((t) => t.includes("Reject Me"));
    expect(msg).toBeTruthy();
    expect(msg).toContain(":x:");
    expect(msg).toContain("Reject Me (in api)");
    expect(msg).toContain("&lt;!here&gt;");
    expect(msg).not.toContain("<!here>");
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
