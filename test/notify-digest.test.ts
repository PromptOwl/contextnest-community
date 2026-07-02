/**
 * Notification digests: bursts of governance events on one nest debounce
 * into a single message ("N updates" + lines) instead of one post per
 * event — sharing a nest with a whole team no longer spams the channel.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/DIGEST";
const sent: string[] = [];

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  process.env.NOTIFY_DEBOUNCE_MS = "60";
  process.env.SLACK_WEBHOOK_URL = WEBHOOK;
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    if (String(url) === WEBHOOK) {
      sent.push(JSON.parse(init.body).text);
      return new Response("ok", { status: 200 });
    }
    throw new Error("unexpected network call");
  });

  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Team Nest" }, alice.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.NOTIFY_DEBOUNCE_MS;
  env.cleanup();
});

describe("notification digests", () => {
  it("collapses a burst (team share) into one digest message", async () => {
    // Share with three people inside the debounce window.
    for (const email of ["a@acme.com", "b@acme.com", "c@acme.com"]) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/collaborators`,
        { email, permission: "read" },
        alice.apiKey,
      );
    }
    await new Promise((r) => setTimeout(r, 150));

    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("3 updates");
    for (const email of ["a@acme.com", "b@acme.com", "c@acme.com"]) {
      expect(sent[0]).toContain(email);
    }
  });

  it("a lone event still sends as its own line, not a digest", async () => {
    sent.length = 0;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "solo@acme.com", permission: "read" },
      alice.apiKey,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(sent.length).toBe(1);
    expect(sent[0]).not.toContain("updates:");
    expect(sent[0]).toContain("solo@acme.com");
  });
});
