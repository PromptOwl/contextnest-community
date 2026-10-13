/**
 * Superadmin message log — GET /admin/messages[/views|/:id].
 *   - superadmin only: nest owners/admins get 403, open mode never qualifies
 *   - every read writes a message_log_views row
 *   - real sends land in the log: inbox rows, a failed email, webhook status
 *   - the log never breaks a send, and prune honours retention
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let superadmin: { apiKey: string; userId: string; email: string };
let owner: { apiKey: string; userId: string; email: string };
let member: { apiKey: string; userId: string; email: string };
let nestId: string;

const get = (path: string, key?: string) => jsonRequest(app, "GET", path, undefined, key);

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@acme.com"] });
  superadmin = await registerUser(app, "root@acme.com", "Root");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  member = await registerUser(app, "member@acme.com", "Member");
  await resetAuthRateLimit();
  const created = await jsonRequest(app, "POST", "/nests", { name: "Ops" }, owner.apiKey);
  nestId = created.data.nest.id;
  // The owner makes the member an admin collaborator on their nest.
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: member.email, permission: "admin" },
    owner.apiKey,
  );
});

afterAll(async () => {
  await env.cleanup();
});

async function db() {
  return (await import("../src/db/client.js")).getDb();
}

async function viewCount(): Promise<number> {
  const row = (await (await db()).get("SELECT COUNT(*) AS n FROM message_log_views")) as { n: number };
  return Number(row.n);
}

describe("access", () => {
  it("refuses nest owners and nest admins", async () => {
    for (const who of [owner, member]) {
      for (const path of ["/admin/messages", "/admin/messages/views", "/admin/messages/x"]) {
        const res = await get(path, who.apiKey);
        expect(res.status).toBe(403);
      }
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await get("/admin/messages");
    expect([401, 403]).toContain(res.status);
  });

  it("serves a superadmin and audits every read", async () => {
    const before = await viewCount();
    const list = await get("/admin/messages?channel=inbox&q=ops", superadmin.apiKey);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data.messages)).toBe(true);
    expect(list.data.retention_days).toBe(30);
    const views = await get("/admin/messages/views", superadmin.apiKey);
    expect(views.status).toBe(200);
    expect((await viewCount()) - before).toBe(2);
    const listRow = views.data.views.find((v: any) => v.action === "list");
    expect(listRow.viewer).toBe("root@acme.com");
    expect(listRow.filters).toMatchObject({ channel: "inbox", q: "ops" });
  });

  it("leaves no audit row for a refused read", async () => {
    const before = await viewCount();
    await get("/admin/messages", member.apiKey);
    expect(await viewCount()).toBe(before);
  });
});

describe("open mode", () => {
  it("never grants the message log, though every caller is admin there", async () => {
    const { isMessageLogViewer } = await import("../src/notify/message-log-routes.js");
    const prev = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "open";
    try {
      expect(await isMessageLogViewer(superadmin.userId)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = prev;
    }
    expect(await isMessageLogViewer(superadmin.userId)).toBe(true);
    expect(await isMessageLogViewer(member.userId)).toBe(false);
  });
});

describe("what gets logged", () => {
  it("logs inbox notifications with sender and recipient", async () => {
    const { insertNotification } = await import("../src/notify/inbox.js");
    await insertNotification(
      { nestId, userEmail: "Member@Acme.com", kind: "assigned", subjectId: "nodes/plan", message: 'owner assigned you "Plan"' },
      { from: owner.email, nodeId: "nodes/plan" },
    );
    const res = await get("/admin/messages?channel=inbox", superadmin.apiKey);
    const row = res.data.messages.find((m: any) => m.subject === "assigned");
    expect(row).toBeTruthy();
    expect(row.recipients).toEqual(["member@acme.com"]);
    expect(row.sender_kind).toBe("human");
    expect(row.sender).toBe(owner.email);
    expect(row.nest_name).toBe("Ops");
    // The list never carries bodies; the detail view does.
    expect(row.body).toBeUndefined();
    const detail = await get(`/admin/messages/${row.id}`, superadmin.apiKey);
    expect(detail.status).toBe(200);
    expect(detail.data.message.body).toBe('owner assigned you "Plan"');
  });

  it("classifies a .invalid sender as an agent persona", async () => {
    const { senderFor } = await import("../src/notify/outbound-log.js");
    expect(senderFor("scout-7f@agents.invalid")).toEqual({ senderKind: "persona", senderId: "scout-7f@agents.invalid" });
    expect(senderFor(null)).toEqual({ senderKind: "system", senderId: null });
  });

  it("records a failed email as failed, with the temp password redacted", async () => {
    process.env.SMTP_URL = "smtp://127.0.0.1:1";
    process.env.NOTIFY_EMAIL_FROM = "nest@acme.com";
    try {
      const { sendEmailToRecipient } = await import("../src/notify/email.js");
      await sendEmailToRecipient(
        "new@acme.com",
        { status: "invited", docTitle: "Ops", path: "Ops", actor: "new@acme.com", tempPassword: "Tmp-Pa55-word!" },
        { nestId },
      );
      const row = (await (await db()).get(
        "SELECT * FROM outbound_messages WHERE channel = 'email' AND recipients_json LIKE '%new@acme.com%' ORDER BY created_at DESC",
      )) as any;
      expect(row).toBeTruthy();
      expect(row.status).toBe("failed");
      expect(row.error).toBeTruthy();
      expect(String(row.body_redacted ?? "")).not.toContain("Tmp-Pa55-word!");
    } finally {
      delete process.env.SMTP_URL;
      delete process.env.NOTIFY_EMAIL_FROM;
    }
  });

  it("logs a service-identity-only email as skipped", async () => {
    process.env.SMTP_URL = "smtp://127.0.0.1:1";
    process.env.NOTIFY_EMAIL_FROM = "nest@acme.com";
    try {
      const { sendEmailToRecipient } = await import("../src/notify/email.js");
      await sendEmailToRecipient("scout@agents.invalid", { status: "rejected", docTitle: "Draft", path: "Ops" });
      const row = (await (await db()).get(
        "SELECT status FROM outbound_messages WHERE recipients_json LIKE '%agents.invalid%'",
      )) as any;
      expect(row.status).toBe("skipped");
    } finally {
      delete process.env.SMTP_URL;
      delete process.env.NOTIFY_EMAIL_FROM;
    }
  });

  it("records webhook delivery status and hides the webhook URL", async () => {
    let status = 200;
    const server: Server = createServer((_req, res) => {
      res.statusCode = status;
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/services/SECRETPATH`;
    try {
      const { postWebhook } = await import("../src/notify/webhook.js");
      await postWebhook(url, { text: "first" }, "connector:c1", { nestId, channel: "webhook" });
      status = 500;
      await postWebhook(url, { text: "second" }, "connector:c1", { nestId, channel: "webhook" });
      const rows = (await (await db()).all(
        "SELECT status, recipients_json, error, via_proxy FROM outbound_messages WHERE channel = 'webhook' ORDER BY created_at",
      )) as any[];
      expect(rows.map((r) => r.status)).toEqual(["sent", "failed"]);
      expect(rows[1].error).toContain("500");
      for (const r of rows) {
        expect(r.recipients_json).not.toContain("SECRETPATH");
        expect(Number(r.via_proxy)).toBe(0);
      }
    } finally {
      server.close();
    }
  });

  it("keeps metadata only when bodies are switched off", async () => {
    process.env.MESSAGE_LOG_STORE_BODIES = "false";
    try {
      const { recordOutbound } = await import("../src/notify/outbound-log.js");
      await recordOutbound({ channel: "inbox", recipients: ["x@acme.com"], subject: "no-body-test", body: "private words", status: "sent" });
      const row = (await (await db()).get("SELECT body_redacted FROM outbound_messages WHERE subject = 'no-body-test'")) as any;
      expect(row.body_redacted).toBeNull();
    } finally {
      delete process.env.MESSAGE_LOG_STORE_BODIES;
    }
  });

  it("caps an oversized body", async () => {
    const { recordOutbound, BODY_CAP } = await import("../src/notify/outbound-log.js");
    await recordOutbound({ channel: "inbox", recipients: ["x@acme.com"], subject: "big-body", body: "x".repeat(20_000), status: "sent" });
    const row = (await (await db()).get("SELECT body_redacted FROM outbound_messages WHERE subject = 'big-body'")) as any;
    expect(row.body_redacted.length).toBeLessThan(BODY_CAP + 40);
    expect(row.body_redacted).toContain("[truncated]");
  });
});

describe("robustness and retention", () => {
  it("prunes messages past retention and view rows past a year", async () => {
    const d = await db();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const ancient = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await d.run(
      "INSERT INTO outbound_messages (id, channel, recipients_json, status, created_at) VALUES ('old-1', 'inbox', '[]', 'sent', ?)",
      [old],
    );
    await d.run(
      "INSERT INTO message_log_views (id, viewer_id, action, at) VALUES ('view-old', 'u', 'list', ?), ('view-mid', 'u', 'list', ?)",
      [ancient, old],
    );
    const { pruneMessageLog } = await import("../src/notify/outbound-log.js");
    await pruneMessageLog();
    expect(await d.get("SELECT id FROM outbound_messages WHERE id = 'old-1'")).toBeUndefined();
    expect(await d.get("SELECT id FROM message_log_views WHERE id = 'view-old'")).toBeUndefined();
    expect(await d.get("SELECT id FROM message_log_views WHERE id = 'view-mid'")).toBeTruthy();
  });

  it("never shows a message past retention, even before the send-count prune", async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await (await db()).run(
      "INSERT INTO outbound_messages (id, channel, recipients_json, status, created_at) VALUES ('old-2', 'inbox', '[]', 'sent', ?)",
      [old],
    );
    const list = await get("/admin/messages?limit=200", superadmin.apiKey);
    expect(list.data.messages.some((m: any) => m.id === "old-2")).toBe(false);
  });

  it("a broken log never breaks a send", async () => {
    const d = await db();
    await d.exec("ALTER TABLE outbound_messages RENAME TO outbound_messages_parked");
    try {
      const { recordOutbound } = await import("../src/notify/outbound-log.js");
      await expect(recordOutbound({ channel: "inbox", recipients: ["a@b.c"], status: "sent" })).resolves.toBeUndefined();
      const { insertNotification } = await import("../src/notify/inbox.js");
      await expect(
        insertNotification({ nestId, userEmail: "member@acme.com", kind: "assigned", subjectId: "n", message: "still delivered" }),
      ).resolves.toBeUndefined();
      expect(await d.get("SELECT id FROM notifications WHERE message = 'still delivered'")).toBeTruthy();
    } finally {
      await d.exec("ALTER TABLE outbound_messages_parked RENAME TO outbound_messages");
    }
  });
});
