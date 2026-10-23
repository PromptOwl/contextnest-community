/**
 * Review SLA escalation → Slack/Teams channels.
 *
 * An escalation reaches channels the same way a review request does:
 *   - the server-wide Slack/Teams webhooks (super-admin Settings) get it via
 *     the debounced digest — the default every nest has with no connector
 *     rows — and exactly once, not also through the immediate dispatch;
 *   - a per-nest connector row gets it when it subscribes to
 *     `review_escalated` (or "*"), like any other event, and not otherwise.
 *
 * Only the wire is mocked (postWebhook), so this exercises the real dispatch
 * and digest code.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

const { postWebhook } = vi.hoisted(() => ({ postWebhook: vi.fn(async () => {}) }));
vi.mock("../src/notify/webhook.js", async () => {
  const actual = await vi.importActual<typeof import("../src/notify/webhook.js")>(
    "../src/notify/webhook.js",
  );
  return { ...actual, postWebhook };
});

type User = { apiKey: string; userId: string; email: string };

const H = 3_600_000;
const SERVER_SLACK = "https://hooks.slack.com/services/T/B/SERVER";
const ESCALATION_ROW = "https://hooks.slack.com/services/T/B/ESC";
const REQUEST_ONLY_ROW = "https://hooks.slack.com/services/T/B/REQ";
const WILDCARD_ROW = "https://hooks.slack.com/services/T/B/ALL";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let alice: User;
let nate: User;
let nestId: string;

const postsTo = (url: string) =>
  postWebhook.mock.calls.filter(
    (c: any[]) => c[0] === url && JSON.stringify(c[1]).includes("escalated"),
  );

beforeAll(async () => {
  process.env.SLACK_WEBHOOK_URL = SERVER_SLACK;
  // Flush the digest immediately so the test doesn't wait out the window.
  process.env.NOTIFY_DEBOUNCE_MS = "0";
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  nate = await registerUser(app, "nate@acme.com", "Nate");

  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Chan" }, owner.apiKey);
  nestId = data.nest.id;
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true, review_sla_hours: 4 },
    owner.apiKey,
  );
  for (const [email, role] of [
    [alice.email, "editor"],
    [nate.email, "reviewer"],
  ]) {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email, role }] },
      owner.apiKey,
    );
    expect(r.status).toBe(201);
  }
  for (const [url, events] of [
    [ESCALATION_ROW, ["review_escalated"]],
    [REQUEST_ONLY_ROW, ["review_requested"]],
    [WILDCARD_ROW, ["*"]],
  ] as const) {
    const c = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/connectors`,
      { channel: "slack", url, events },
      owner.apiKey,
    );
    expect(c.status).toBe(201);
  }

  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Pricing", content: "v1" },
    alice.apiKey,
  );
  const s = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/nodes/pricing/submit-review`,
    {},
    alice.apiKey,
  );
  expect(s.status).toBe(201);
  await new Promise((r) => setTimeout(r, 100));
  postWebhook.mockClear();

  const { reviewSlaTick } = await import("../src/governance/review-sla.js");
  const out = await reviewSlaTick(Date.now() + 5 * H);
  expect(out).toHaveLength(1);
  expect(out[0].recipients).toEqual([nate.email]);
  await new Promise((r) => setTimeout(r, 150));
});

afterAll(async () => {
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.NOTIFY_DEBOUNCE_MS;
  await env.cleanup();
});

describe("review_escalated on channels", () => {
  it("reaches the server-wide webhook by default, exactly once", () => {
    const posts = postsTo(SERVER_SLACK);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0][1])).toContain("Pricing");
    expect(JSON.stringify(posts[0][1])).toContain(nate.email);
  });

  it("reaches a per-nest connector subscribed to review_escalated", () => {
    expect(postsTo(ESCALATION_ROW)).toHaveLength(1);
  });

  it('reaches a per-nest connector subscribed to "*"', () => {
    expect(postsTo(WILDCARD_ROW)).toHaveLength(1);
  });

  it("does not reach a connector that only subscribed to review_requested", () => {
    expect(postsTo(REQUEST_ONLY_ROW)).toHaveLength(0);
  });

  it("is offered as a connector event (unknown events are refused)", async () => {
    const ok = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/connectors`,
      { channel: "webhook", url: "https://example.com/hook", events: ["review_escalated"] },
      owner.apiKey,
    );
    expect(ok.status).toBe(201);
    const bad = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/connectors`,
      { channel: "webhook", url: "https://example.com/hook", events: ["review_overdue"] },
      owner.apiKey,
    );
    expect(bad.status).toBe(400);
  });
});
