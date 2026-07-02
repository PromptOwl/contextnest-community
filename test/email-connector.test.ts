/**
 * Email connector: SMTP notifications via nodemailer (pinned 9.0.3, see the
 * supply-chain scan in the PR). Hardened usage — SMTP transport only,
 * disableFileAccess/disableUrlAccess everywhere, no raw option, and a
 * failure can never break the governance action.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

const sendMail = vi.fn(async () => ({ messageId: "test" }));
const createTransport = vi.fn(() => ({ sendMail }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  process.env.NOTIFY_DEBOUNCE_MS = "10"; // near-instant flush for tests
  process.env.SMTP_URL = "smtps://user:pass@smtp.test:465";
  process.env.NOTIFY_EMAIL_FROM = "nest@test.local";
  process.env.NOTIFY_EMAIL_TO = "team@test.local";
  delete process.env.SLACK_WEBHOOK_URL;

  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Mail Nest" }, alice.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => {
  delete process.env.SMTP_URL;
  delete process.env.NOTIFY_EMAIL_FROM;
  delete process.env.NOTIFY_EMAIL_TO;
  env.cleanup();
});

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("email connector", () => {
  it("sends on a governance event with hardened transport + message options", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "bob@acme.com", permission: "write" },
      alice.apiKey,
    );
    await settle();

    // Transport built from the SMTP URL with file/URL access disabled.
    expect(createTransport).toHaveBeenCalledWith(
      "smtps://user:pass@smtp.test:465",
      expect.objectContaining({
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );

    expect(sendMail).toHaveBeenCalled();
    const msg = sendMail.mock.calls[0][0] as any;
    expect(msg.from).toBe("nest@test.local");
    expect(msg.to).toBe("team@test.local");
    expect(msg.subject).toContain("Mail Nest");
    expect(msg.text).toContain("bob@acme.com");
    // Hardened per the scan: belt-and-braces flags on the message, no raw.
    expect(msg.disableFileAccess).toBe(true);
    expect(msg.disableUrlAccess).toBe(true);
    expect(msg.raw).toBeUndefined();
  });

  it("a throwing SMTP transport never breaks the action", async () => {
    sendMail.mockRejectedValueOnce(new Error("smtp down"));
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "carol@acme.com", permission: "read" },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
  });

  it("does nothing when from/to are missing", async () => {
    delete process.env.NOTIFY_EMAIL_TO;
    sendMail.mockClear();
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "dave@acme.com", permission: "read" },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    await settle();
    expect(sendMail).not.toHaveBeenCalled();
    process.env.NOTIFY_EMAIL_TO = "team@test.local";
  });
});

describe("admin settings validation", () => {
  it("rejects a non-smtp URL and accepts empty to disable", async () => {
    const openApp = await createTestApp("open");
    const bad = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      smtp_url: "https://not-smtp.example.com",
    });
    expect(bad.status).toBe(400);
    const clear = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      smtp_url: "",
      notify_email_from: "",
      notify_email_to: "",
    });
    expect(clear.status).toBe(200);
    expect(clear.data.settings.smtp_url).toBe("");
    process.env.SMTP_URL = "smtps://user:pass@smtp.test:465";
    process.env.NOTIFY_EMAIL_FROM = "nest@test.local";
    process.env.NOTIFY_EMAIL_TO = "team@test.local";
  });
});
