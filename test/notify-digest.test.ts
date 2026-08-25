/**
 * Notification digests: bursts of governance events on one nest debounce
 * into a single message ("N updates" + lines) instead of one post per
 * event — sharing a nest with a whole team no longer spams the channel.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { config } from "../src/config.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/DIGEST";
const sent: string[] = [];

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  // Window has to outlast the HTTP round-trips of a burst on a loaded CI box,
  // or the buffer flushes mid-burst and the digest splits in two.
  process.env.NOTIFY_DEBOUNCE_MS = "300";
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
    await new Promise((r) => setTimeout(r, 400));

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
    await new Promise((r) => setTimeout(r, 400));
    expect(sent.length).toBe(1);
    expect(sent[0]).not.toContain("updates:");
    expect(sent[0]).toContain("solo@acme.com");
  });

  it("caps the digest at DIGEST_LINE_CAP lines with an '…and K more' tail", async () => {
    sent.length = 0;
    // Widen the window so all 12 requests land in one burst deterministically.
    process.env.NOTIFY_DEBOUNCE_MS = "800";
    for (let i = 0; i < 12; i++) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/collaborators`,
        { email: `u${i}@acme.com`, permission: "read" },
        alice.apiKey,
      );
    }
    await new Promise((r) => setTimeout(r, 900));
    process.env.NOTIFY_DEBOUNCE_MS = "300";

    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("12 updates");
    // 12 events, cap 10 → two lines truncated.
    expect(sent[0]).toContain("…and 2 more");
    expect(sent[0].split("\n").filter((l) => l.startsWith("• ")).length).toBe(10);
  });

  it("buffers each nest independently — one nest's burst never merges with another's", async () => {
    sent.length = 0;
    process.env.NOTIFY_DEBOUNCE_MS = "600";
    const other = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Other Nest" },
      alice.apiKey,
    );
    const otherId = other.data.nest.id;

    // Burst on nest A (2 events) + a single event on nest B, all in one window.
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: "a1@acme.com", permission: "read" }, alice.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: "a2@acme.com", permission: "read" }, alice.apiKey);
    await jsonRequest(app, "POST", `/nests/${otherId}/collaborators`, { email: "b1@acme.com", permission: "read" }, alice.apiKey);
    await new Promise((r) => setTimeout(r, 700));
    process.env.NOTIFY_DEBOUNCE_MS = "300";

    expect(sent.length).toBe(2);
    const digest = sent.find((s) => s.includes("2 updates"));
    const single = sent.find((s) => !s.includes("updates:"));
    expect(digest).toBeDefined();
    expect(single).toBeDefined();
    // Nest B's lone event stayed on its own, not swept into nest A's digest.
    expect(digest).not.toContain("b1@acme.com");
    expect(single).toContain("b1@acme.com");
  });
});

describe("config.NOTIFY_DEBOUNCE_MS fallback", () => {
  const original = process.env.NOTIFY_DEBOUNCE_MS;
  afterAll(() => {
    if (original === undefined) delete process.env.NOTIFY_DEBOUNCE_MS;
    else process.env.NOTIFY_DEBOUNCE_MS = original;
  });

  it("defaults to 15000 for unset / empty / non-numeric / negative, honours a valid value", () => {
    delete process.env.NOTIFY_DEBOUNCE_MS;
    expect(config.NOTIFY_DEBOUNCE_MS).toBe(15_000);
    // Set-but-empty (NOTIFY_DEBOUNCE_MS=): Number("") is 0, must NOT yield 0ms.
    process.env.NOTIFY_DEBOUNCE_MS = "";
    expect(config.NOTIFY_DEBOUNCE_MS).toBe(15_000);
    process.env.NOTIFY_DEBOUNCE_MS = "   ";
    expect(config.NOTIFY_DEBOUNCE_MS).toBe(15_000);
    process.env.NOTIFY_DEBOUNCE_MS = "abc";
    expect(config.NOTIFY_DEBOUNCE_MS).toBe(15_000);
    process.env.NOTIFY_DEBOUNCE_MS = "-5";
    expect(config.NOTIFY_DEBOUNCE_MS).toBe(15_000);
    process.env.NOTIFY_DEBOUNCE_MS = "250";
    expect(config.NOTIFY_DEBOUNCE_MS).toBe(250);
  });
});
