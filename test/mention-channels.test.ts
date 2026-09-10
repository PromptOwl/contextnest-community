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

  it("emails the person who was named, not the team inbox", async () => {
    expect(sendMail).toHaveBeenCalled();
    const to = sendMail.mock.calls
      .map((c: any[]) => c[0])
      .filter((m: any) => JSON.stringify(m.subject || "").includes("Launch Plan"));
    expect(to).toHaveLength(1);
    expect(JSON.stringify(to[0].to)).toContain(editor.email);
    expect(JSON.stringify(to[0].text)).toContain("Launch Plan");
  });
});
