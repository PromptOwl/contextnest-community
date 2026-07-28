/**
 * Email connector: SMTP notifications via nodemailer (pinned 9.0.3, see the
 * supply-chain scan in the PR). Hardened usage — SMTP transport only,
 * disableFileAccess/disableUrlAccess everywhere, no raw option, and a
 * failure can never break the governance action.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { withTimeouts, withPool, isRateLimited } from "../src/notify/email.js";

const sendMail = vi.fn(async () => ({ messageId: "test" }));
const verify = vi.fn(async () => true);
const close = vi.fn();
const createTransport = vi.fn(() => ({ sendMail, verify, close }));
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

// Notify dispatch is debounced + the SMTP send is async, so a fixed sleep
// races the flush under a loaded (full-suite, parallel) test run. Poll for the
// spy instead of guessing a delay. `settle` stays for the negative assertions
// (proving a send did NOT happen needs a bounded wait, not a poll).
const settle = () => new Promise((r) => setTimeout(r, 50));
const waitForSend = () =>
  vi.waitFor(() => expect(sendMail).toHaveBeenCalled(), { timeout: 3000 });

describe("email connector", () => {
  it("sends on a governance event with hardened transport + message options", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "bob@acme.com", permission: "write" },
      alice.apiKey,
    );
    await waitForSend();
    // An invite emails the INVITEE directly, not the shared NOTIFY_EMAIL_TO
    // team inbox (the team-channel email is suppressed for invite events).
    await settle();
    const recipients = sendMail.mock.calls.map((c) => (c[0] as any).to);
    expect(recipients).toContain("bob@acme.com");
    expect(recipients).not.toContain("team@test.local");

    // Transport built from the SMTP URL with file/URL access disabled.
    expect(createTransport).toHaveBeenCalled();
    const [urlArg, optsArg] = createTransport.mock.calls[0] as [string, any];
    expect(urlArg).toContain("smtps://user:pass@smtp.test:465");
    // Timeouts MUST ride on the URL query string — nodemailer ignores socket
    // timeouts passed in the options arg when the transport is a URL string.
    // Asserting them on the URL is what catches a regression back to the
    // (silently-ignored) options-arg placement.
    expect(urlArg).toContain("connectionTimeout=5000");
    expect(urlArg).toContain("greetingTimeout=5000");
    expect(urlArg).toContain("socketTimeout=10000");
    expect(optsArg).toEqual(
      expect.objectContaining({
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );

    // Inspect the invitee's direct email — addressed to them in the second
    // person ("You've been given write access …"), not the third.
    const msg = sendMail.mock.calls.find(
      (c) => (c[0] as any).to === "bob@acme.com",
    )![0] as any;
    expect(msg.from).toBe("nest@test.local");
    expect(msg.subject).toContain("Mail Nest");
    expect(msg.text).toContain("You've been given write access to Mail Nest");
    // Multipart: a branded HTML part is sent alongside the plain-text fallback,
    // *bold* markup is rendered, and the raw shortcode markers don't leak.
    expect(msg.html).toContain("ContextNest");
    expect(msg.html).toContain("<strong>");
    expect(msg.html).not.toContain(":key:");
    expect(msg.text).not.toContain("*");
    // The document/nest link is derived from the request origin — no
    // PUBLIC_BASE_URL configured in this test, yet a link is still built.
    expect(process.env.PUBLIC_BASE_URL).toBeUndefined();
    expect(msg.html).toContain("http://localhost/?nest=");
    expect(msg.html).toContain(">Open nest<");
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

  it("strips CR/LF from the nest name before it reaches the Subject header", async () => {
    sendMail.mockClear();
    const evil = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Injected\r\nBcc: attacker@evil.com" },
      alice.apiKey,
    );
    const evilId = evil.data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${evilId}/collaborators`,
      { email: "eve@acme.com", permission: "read" },
      alice.apiKey,
    );
    await waitForSend();
    const msg = sendMail.mock.calls[0][0] as any;
    expect(msg.subject).not.toContain("\n");
    expect(msg.subject).not.toContain("\r");
  });

  it("does nothing when from is missing (email channel off)", async () => {
    // FROM gates BOTH the team-channel digest AND the invitee-direct email, so
    // clearing it disables all email delivery (TO alone only silences the team
    // channel — the invitee is still emailed at their own address).
    delete process.env.NOTIFY_EMAIL_FROM;
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
    process.env.NOTIFY_EMAIL_FROM = "nest@test.local";
  });
});

describe("withTimeouts (SMTP URL socket-timeout hardening)", () => {
  it("appends all three timeouts when the URL has no query string", () => {
    const out = withTimeouts("smtps://u:p@host:465");
    expect(out).toContain("connectionTimeout=5000");
    expect(out).toContain("greetingTimeout=5000");
    expect(out).toContain("socketTimeout=10000");
  });

  it("adds pool + rate-limit params, and never duplicates an admin-set one", () => {
    const out = withPool("smtps://u:p@host:465");
    expect(out).toContain("pool=true");
    expect(out).toContain("maxConnections=1");
    expect(out).toContain("rateDelta=1000");
    expect(out).toContain("rateLimit=8");
    // An admin-supplied rateLimit wins and is not appended a second time.
    const preset = withPool("smtps://u:p@host:465?rateLimit=20");
    expect(preset.match(/rateLimit=/g)).toHaveLength(1);
    expect(preset).toContain("rateLimit=20");
    expect(preset).toContain("pool=true");
  });

  it("classifies rate-limit / throttle errors as retryable, hard rejects as not", () => {
    // The exact Mailtrap reply from the field, plus common throttle shapes.
    expect(isRateLimited({ message: "Data command failed: 550 5.7.0 Too many emails per second", responseCode: 550 })).toBe(true);
    expect(isRateLimited({ message: "Too many requests", responseCode: 429 })).toBe(true);
    expect(isRateLimited({ message: "421 4.7.0 try again later", responseCode: 421 })).toBe(true);
    // Hard failures must NOT retry (would waste attempts and never succeed).
    expect(isRateLimited({ message: "550 5.1.1 No such user", responseCode: 550 })).toBe(false);
    expect(isRateLimited({ message: "535 Authentication failed", responseCode: 535 })).toBe(false);
  });

  it("preserves an admin-supplied timeout and never duplicates the key", () => {
    // A duplicate query key makes nodemailer parse the value as an array
    // (['9999','5000']) which disables the timeout — so an existing value
    // must win and NOT be appended again.
    const out = withTimeouts("smtps://u:p@host:465?connectionTimeout=9999");
    expect(out.match(/connectionTimeout=/g)).toHaveLength(1);
    expect(out).toContain("connectionTimeout=9999");
    // The other two are still filled in, joined onto the existing query.
    expect(out).toContain("greetingTimeout=5000");
    expect(out).toContain("socketTimeout=10000");
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

  it("verifies SMTP credentials before saving — blocks a save when connect/auth fails", async () => {
    const openApp = await createTestApp("open");
    verify.mockClear();
    close.mockClear();
    verify.mockRejectedValueOnce(new Error("Invalid login: 535 auth failed"));
    const bad = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      smtp_url: "smtps://user:wrongpass@smtp.test:465",
    });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/SMTP connection failed/i);
    expect(bad.data.error).toMatch(/535 auth failed/);
    // Keyed to smtp_url so the client focuses the Notifications tab.
    expect(bad.data.fieldErrors?.smtp_url).toMatch(/SMTP connection failed/i);
    // Verify ran on the supplied URL and the throwaway transporter was closed.
    expect(verify).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    // Nothing persisted — the live SMTP_URL is unchanged.
    expect(process.env.SMTP_URL).toBe("smtps://user:pass@smtp.test:465");
  });

  it("saves a new SMTP URL once verify() succeeds", async () => {
    const openApp = await createTestApp("open");
    verify.mockClear();
    verify.mockResolvedValueOnce(true);
    const ok = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      smtp_url: "smtps://user:pass@smtp.verified:465",
    });
    expect(ok.status).toBe(200);
    expect(verify).toHaveBeenCalled();
    expect(ok.data.settings.smtp_url).toBe("smtps://user:pass@smtp.verified:465");
    // Restore the shared fixture URL for the remaining tests.
    process.env.SMTP_URL = "smtps://user:pass@smtp.test:465";
  });

  it("skips verify when the SMTP URL is cleared (disabling the connector)", async () => {
    const openApp = await createTestApp("open");
    verify.mockClear();
    const off = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      smtp_url: "",
    });
    expect(off.status).toBe(200);
    expect(verify).not.toHaveBeenCalled();
    process.env.SMTP_URL = "smtps://user:pass@smtp.test:465";
  });

  it("rejects a malformed notify_email_from / notify_email_to", async () => {
    const openApp = await createTestApp("open");
    const badFrom = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      notify_email_from: "not-an-email",
    });
    expect(badFrom.status).toBe(400);
    // Errors are keyed by field name so the client can focus the right tab.
    expect(badFrom.data.fieldErrors).toHaveProperty("notify_email_from");
    // A comma-list where one entry is malformed rejects the whole field.
    const badTo = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      notify_email_to: "ok@acme.com, bogus",
    });
    expect(badTo.status).toBe(400);
    expect(badTo.data.fieldErrors).toHaveProperty("notify_email_to");
    // A bare @ with no dotted domain (e.g. "a@b", "test@test") is junk that
    // passes a transport envelope but isn't a real address — rejected.
    const noDot = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      notify_email_from: "test@test",
    });
    expect(noDot.status).toBe(400);
    // From is a single sender — a comma-list (valid for To) is rejected with a
    // message that points the admin at the Recipients field.
    const multiFrom = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      notify_email_from: "a@acme.com, b@acme.com",
    });
    expect(multiFrom.status).toBe(400);
    expect(multiFrom.data.fieldErrors.notify_email_from).toMatch(/single email/i);
    // A header-injection shape (interior CR/LF, survives .trim()) is rejected.
    const crlf = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      notify_email_from: "nest@acme.com\nBcc: attacker@evil.com",
    });
    expect(crlf.status).toBe(400);
    // Well-formed values round-trip.
    const good = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      notify_email_from: "nest@acme.com",
      notify_email_to: "a@acme.com, b@acme.com",
    });
    expect(good.status).toBe(200);
    process.env.SMTP_URL = "smtps://user:pass@smtp.test:465";
    process.env.NOTIFY_EMAIL_FROM = "nest@test.local";
    process.env.NOTIFY_EMAIL_TO = "team@test.local";
  });
});
