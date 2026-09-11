/**
 * "…and as a message if configured" (CU-wdqcq01rxw).
 *
 * A mention lands in the queue as an inbox row (comment-mentions.test.ts);
 * this suite covers the outbound half — the configured connector channel and,
 * when SMTP is set up, an email to the person actually named. Both boundaries
 * are mocked, so this asserts what the fan-out sends, not the wire.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

const sendMail = vi.fn(async () => ({ messageId: "test" }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({ sendMail, verify: async () => true, close() {} }),
  },
}));

const { postWebhook } = vi.hoisted(() => ({ postWebhook: vi.fn(async () => {}) }));
vi.mock("../src/notify/webhook.js", async () => {
  const actual = await vi.importActual<typeof import("../src/notify/webhook.js")>(
    "../src/notify/webhook.js",
  );
  return { ...actual, postWebhook };
});

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; email: string };
let editor: { apiKey: string; email: string };
let nestId: string;

beforeAll(async () => {
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T/B/X";
  process.env.SMTP_URL = "smtps://user:pass@smtp.test:465";
  process.env.NOTIFY_EMAIL_FROM = "nest@test.local";

  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  await resetAuthRateLimit();
  editor = await registerUser(app, "editor@acme.com", "Eddie Editor");
  await resetAuthRateLimit();

  const nest = await jsonRequest(app, "POST", "/nests", { name: "Channels" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: editor.email, permission: "write" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Launch Plan", content: "the plan" },
    owner.apiKey,
  );
  // Clear the invite's own notifications before the mention under test.
  sendMail.mockClear();
  postWebhook.mockClear();

  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/nodes/launch-plan/annotations`,
    { body: `@${editor.email} can you confirm the date?` },
    owner.apiKey,
  );
  // The channel fan-out is fire-and-forget — give it a beat to land.
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(async () => {
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.SMTP_URL;
  delete process.env.NOTIFY_EMAIL_FROM;
  await env.cleanup();
});

describe("connector reachability", () => {
  it("reports whether an event has anywhere to go", async () => {
    // The channel budget is only charged when this says yes — otherwise a
    // nest with no connector pays a token for a dispatch that no-ops, and
    // then reports messages "skipped" that were never sendable.
    const { hasAnyConnector } = await import("../src/notify/dispatch.js");
    // This suite configures a server-wide Slack webhook, so any nest is
    // reachable — including one that has no connector row of its own.
    expect(await hasAnyConnector(nestId, "mention")).toBe(true);
    expect(await hasAnyConnector("no-such-nest", "mention")).toBe(true);
    // …but not for kinds the digest path delivers instead (dispatchEvent
    // skips them on the server-wide webhook, so this must too).
    expect(await hasAnyConnector(nestId, "review_requested")).toBe(false);

    const saved = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      // With the server-wide webhooks gone and no per-nest row, nothing can
      // be delivered — which is the case that must not spend a token.
      expect(await hasAnyConnector(nestId, "mention")).toBe(false);

      // A per-nest row counts only for the kinds it subscribed to: a
      // review-only connector won't post a mention, so no token for it.
      const nest = await jsonRequest(app, "POST", "/nests", { name: "Rows" }, owner.apiKey);
      const rowsNest = nest.data.nest.id;
      await jsonRequest(
        app,
        "POST",
        `/nests/${rowsNest}/connectors`,
        { channel: "slack", url: "https://hooks.slack.com/services/T/B/R", events: ["review_requested"] },
        owner.apiKey,
      );
      expect(await hasAnyConnector(rowsNest, "mention")).toBe(false);
      expect(await hasAnyConnector(rowsNest, "review_requested")).toBe(true);
    } finally {
      process.env.SLACK_WEBHOOK_URL = saved;
    }
  });

  it("a per-nest connector can subscribe to mention and receives it", async () => {
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Sub" }, owner.apiKey);
    const subNest = nest.data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${subNest}/collaborators`,
      { email: editor.email, permission: "write" },
      owner.apiKey,
    );
    const rowUrl = "https://hooks.slack.com/services/T/B/SUB";
    const create = await jsonRequest(
      app,
      "POST",
      `/nests/${subNest}/connectors`,
      { channel: "slack", url: rowUrl, events: ["mention"] },
      owner.apiKey,
    );
    expect(create.status).toBe(201);

    await jsonRequest(
      app,
      "POST",
      `/nests/${subNest}/nodes`,
      { title: "Sub Doc", content: "body" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${subNest}/nodes/nodes/sub-doc/annotations`,
      { body: `@${editor.email} subscribed?` },
      owner.apiKey,
    );
    await new Promise((r) => setTimeout(r, 150));

    const toRow = postWebhook.mock.calls.filter(
      (c: any[]) => c[0] === rowUrl && JSON.stringify(c[1]).includes("Sub Doc"),
    );
    expect(toRow).toHaveLength(1);
  });
});

describe("mention delivery budget", () => {
  it("stops the outbound stream but never the inbox rows", async () => {
    const { MENTION_DELIVERY_BUDGET } = await import(
      "../src/governance/mention-notify.js"
    );
    // Its OWN nest, and no mockClear: the budget is keyed per actor per nest,
    // and the spies are shared with the tests below — burning the budget or
    // resetting the calls they assert on would break them (which it did, the
    // first time this test was written).
    const nest = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Burst" },
      owner.apiKey,
    );
    const burstNest = nest.data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${burstNest}/collaborators`,
      { email: editor.email, permission: "write" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${burstNest}/nodes`,
      { title: "Burst Doc", content: "body" },
      owner.apiKey,
    );

    // One email per comment (each names one person), so the loop has to go
    // PAST the budget to see it bite — at exactly the budget nothing is
    // dropped, which is the point of the email pool being its own: 50
    // deliveries means 50, not 25 shared with channel posts.
    const comments = MENTION_DELIVERY_BUDGET.max + 5;
    for (let i = 0; i < comments; i++) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${burstNest}/nodes/nodes/burst-doc/annotations`,
        { body: `burst ${i} for @${editor.email}` },
        owner.apiKey,
      );
    }
    await new Promise((r) => setTimeout(r, 150));

    // The mail that leaves the server is capped…
    const burstMail = sendMail.mock.calls
      .map((c: any[]) => c[0])
      .filter((m: any) => JSON.stringify(m.text || "").includes("burst "));
    expect(burstMail.length).toBeGreaterThan(0);
    expect(burstMail.length).toBeLessThan(comments);
    // …and the cap is the documented one, not a fraction of it.
    expect(burstMail.length).toBe(MENTION_DELIVERY_BUDGET.max);

    // …while every mention still reached the recipient's queue, which is the
    // record they actually work from. Read through the service with a real
    // limit, not GET /me/notifications: that route ignores a `limit` param and
    // always returns the newest 50, so asserting on it would have measured its
    // page size rather than the inserts (which is exactly what it did first).
    const { listNotifications } = await import(
      "../src/governance/notify-service.js"
    );
    const rows = await listNotifications(editor.email, { limit: 200 });
    const inBurstNest = rows.filter(
      (n) => n.kind === "mention" && n.nest_id === burstNest,
    );
    expect(inBurstNest.length).toBe(comments);
  });
});

describe("mention channels", () => {
  it("delivers a document-body mention to the channel and the person too", async () => {
    // The changeset advertises this as new (document mentions used to be
    // inbox-only), and it rides the same deliverMentionMessages as a comment —
    // but "very likely fine because it shares a helper" is not a test.
    // Deliberately NOT clearing the spies: the sibling tests assert on the
    // comment fired in beforeAll, so each test filters by its own document
    // title instead of resetting shared state out from under the others.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Q4 Brief", content: `owner needs @${editor.email} on this` },
      owner.apiKey,
    );
    await new Promise((r) => setTimeout(r, 100));

    const posted = postWebhook.mock.calls
      .map((c: any[]) => JSON.stringify(c[1]))
      .find((b) => b.includes("Q4 Brief"));
    expect(posted).toBeTruthy();
    expect(posted).toContain("mentioned");
    expect(posted).toContain(editor.email);

    const mailed = sendMail.mock.calls
      .map((c: any[]) => c[0])
      .filter((m: any) => JSON.stringify(m.subject || "").includes("Q4 Brief"));
    expect(mailed).toHaveLength(1);
    expect(JSON.stringify(mailed[0].to)).toContain(editor.email);
  });

  it("posts the mention to the configured connector", async () => {
    expect(postWebhook).toHaveBeenCalled();
    const bodies = postWebhook.mock.calls.map((c: any[]) => JSON.stringify(c[1]));
    const mention = bodies.find((b) => b.includes("Launch Plan"));
    expect(mention).toBeTruthy();
    expect(mention).toContain("Launch Plan");
    expect(mention).toContain(owner.email);
    // A channel is not a person: the message names who was mentioned rather
    // than saying "mentioned you" to a room.
    expect(mention).toContain(editor.email);
    expect(mention).not.toContain("mentioned you");
    // And no comment prose: a channel's audience is configured per nest, not
    // derived from who can read the document.
    expect(mention).not.toContain("confirm the date");
  });

  it("gives an agent's comment the same working link as a human's", async () => {
    // A mention left through MCP goes through the same fan-out, but the tool
    // has to hand it a base URL: without one, docLink falls back to
    // PUBLIC_BASE_URL and the email's "Open document" button points at "".
    const res = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${owner.apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "context_comment",
          arguments: {
            id: "nodes/launch-plan",
            body: `handled — @${editor.email} please confirm`,
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    const mailed = sendMail.mock.calls
      .map((c: any[]) => c[0])
      .filter((m: any) => JSON.stringify(m.text || "").includes("please confirm"));
    expect(mailed).toHaveLength(1);
    // The link is present and absolute — the shape docLink builds.
    expect(String(mailed[0].text)).toMatch(/https?:\/\/[^\s]+\?nest=/);
  });

  it("emails the person who was named, not the team inbox", async () => {
    expect(sendMail).toHaveBeenCalled();
    // Filtered on this comment's own words, not its document title: a sibling
    // test comments on the same document, and a title filter would count both.
    const to = sendMail.mock.calls
      .map((c: any[]) => c[0])
      .filter((m: any) => JSON.stringify(m.text || "").includes("confirm the date"));
    expect(to).toHaveLength(1);
    expect(JSON.stringify(to[0].to)).toContain(editor.email);
    expect(JSON.stringify(to[0].text)).toContain("Launch Plan");
  });
});

describe("mention invite (directory toggle on)", () => {
  it("adds the outsider without the 'added as read' channel post", async () => {
    // The mention notifies the person itself; a second "X added as read"
    // post on top would announce the same event twice. Pinned so the raw
    // insert in inviteMentioned stays deliberate rather than an omission.
    process.env.PEOPLE_SUGGEST_ALL_USERS = "true";
    try {
      const outsider = await registerUser(app, "new@acme.com", "Newcomer");
      await resetAuthRateLimit();
      const nest = await jsonRequest(app, "POST", "/nests", { name: "Invite" }, owner.apiKey);
      const inviteNest = nest.data.nest.id;
      await jsonRequest(
        app,
        "POST",
        `/nests/${inviteNest}/nodes`,
        { title: "Invite Doc", content: "body" },
        owner.apiKey,
      );
      postWebhook.mockClear();
      await jsonRequest(
        app,
        "POST",
        `/nests/${inviteNest}/nodes/nodes/invite-doc/annotations`,
        { body: `welcome @${outsider.email}` },
        owner.apiKey,
      );
      await new Promise((r) => setTimeout(r, 150));

      const bodies = postWebhook.mock.calls.map((c: any[]) => JSON.stringify(c[1]));
      expect(bodies.some((b) => b.includes("Invite Doc") && b.includes(outsider.email))).toBe(true);
      expect(bodies.some((b) => b.includes("added as"))).toBe(false);
    } finally {
      delete process.env.PEOPLE_SUGGEST_ALL_USERS;
    }
  });
});
