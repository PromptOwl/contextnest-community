/**
 * Share emails: one email per document/folder share, one per nest share, and
 * no per-document email to someone the whole nest is already shared with.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

const sendMail = vi.fn(async (_m: any) => ({ messageId: "test" }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({ sendMail, verify: async () => true, close() {} }),
  },
}));

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; email: string };
let nestId: string;

const settle = () => new Promise((r) => setTimeout(r, 100));
const mailTo = (email: string) =>
  sendMail.mock.calls.map((c) => c[0]).filter((m) => m.to === email);

beforeAll(async () => {
  process.env.SMTP_URL = "smtps://user:pass@smtp.test:465";
  process.env.NOTIFY_EMAIL_FROM = "nest@test.local";
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  await resetAuthRateLimit();
  await registerUser(app, "guest@acme.com", "Guest");
  await resetAuthRateLimit();
  await registerUser(app, "member@acme.com", "Member");
  await resetAuthRateLimit();
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Private" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Shared One", content: "# a" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Shared Two", content: "# b" }, owner.apiKey);
  await settle();
  sendMail.mockClear();
});

afterAll(async () => {
  delete process.env.SMTP_URL;
  delete process.env.NOTIFY_EMAIL_FROM;
  await env.cleanup();
});

const grant = (email: string, target: string, role = "read") =>
  jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/grants`,
    { target_type: "document", target, email, role },
    owner.apiKey,
  );

describe("share emails", () => {
  it("sends one email for one shared document", async () => {
    const res = await grant("guest@acme.com", "nodes/shared-one");
    expect(res.status).toBe(201);
    await settle();
    const mails = mailTo("guest@acme.com");
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe("Shared One was shared with you");
    expect(mails[0].text).toContain("Viewer access to Shared One");
  });

  it("sends nothing when an existing grant only changes role", async () => {
    sendMail.mockClear();
    await grant("guest@acme.com", "nodes/shared-one", "write");
    await settle();
    expect(mailTo("guest@acme.com")).toHaveLength(0);
  });

  it("sends one email for a nest share and none per document after it", async () => {
    sendMail.mockClear();
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "member@acme.com", permission: "read" },
      owner.apiKey,
    );
    await settle();
    expect(mailTo("member@acme.com")).toHaveLength(1);

    sendMail.mockClear();
    await grant("member@acme.com", "nodes/shared-two", "write");
    await settle();
    expect(mailTo("member@acme.com")).toHaveLength(0);
  });
});
