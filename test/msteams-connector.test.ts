/**
 * Microsoft Teams connector: admin-configured incoming webhook (Workflows
 * app); governance events (review submitted/approved/rejected, nest shared)
 * post fire-and-forget Adaptive Cards. Empty/unset URL = connector off;
 * failures never break the underlying action. Mirrors slack-connector.test.ts
 * — the two connectors are contractually at parity.
 *
 * Setting names are msteams_* / MSTEAMS_* on purpose: "teams" in this
 * codebase means user groups (/teams routes), not Microsoft Teams.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { msTeamsPayload } from "../src/notify/msteams.js";
import { dispatchEvent } from "../src/notify/dispatch.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

const WEBHOOK = "https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke";
// A per-nest connector row's target (dispatch-only path) — captured separately.
const ROW_URL = "https://teams-hook.example.com/hook";
const sent: Array<{ url: string; payload: any }> = [];
const rowSent: any[] = [];
const realFetch = globalThis.fetch;

/** Every TextBlock of the (single) Adaptive Card, joined — the card's text. */
function cardText(payload: any): string {
  return (payload.attachments?.[0]?.content?.body ?? [])
    .map((b: any) => b.text)
    .join("\n");
}

/** The wire envelope Workflows-app webhooks require. */
function expectAdaptiveCardEnvelope(payload: any): void {
  expect(payload.type).toBe("message");
  expect(payload.attachments).toHaveLength(1);
  expect(payload.attachments[0].contentType).toBe(
    "application/vnd.microsoft.card.adaptive",
  );
  expect(payload.attachments[0].content.type).toBe("AdaptiveCard");
}

beforeAll(async () => {
  process.env.NOTIFY_DEBOUNCE_MS = "10"; // near-instant flush for tests
  process.env.MSTEAMS_WEBHOOK_URL = WEBHOOK;
  vi.stubGlobal(
    "fetch",
    async (url: any, init?: any) => {
      const u = String(url);
      if (u === WEBHOOK) {
        sent.push({ url: u, payload: JSON.parse(init.body) });
        return new Response("ok", { status: 200 });
      }
      if (u === ROW_URL) {
        rowSent.push(JSON.parse(init.body));
        return new Response("ok", { status: 200 });
      }
      // Any other webhook URL simulates an outage; nothing in this suite may
      // touch the real network.
      if (u.includes("logic.azure.com")) throw new Error("simulated outage");
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
  delete process.env.MSTEAMS_WEBHOOK_URL;
  delete process.env.NOTIFY_DEBOUNCE_MS;
  env.cleanup();
});

// Notifications are fire-and-forget — give the microtask a beat to land.
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("Microsoft Teams connector", () => {
  it("posts an Adaptive Card when a collaborator is added, titled with the nest name", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "bob@acme.com", permission: "write" },
      alice.apiKey,
    );
    await settle();
    const msg = sent.find((s) => cardText(s.payload).includes("bob@acme.com"));
    expect(msg).toBeTruthy();
    expectAdaptiveCardEnvelope(msg!.payload);
    // Nest name is the card title (first, bolded TextBlock).
    const body = msg!.payload.attachments[0].content.body;
    expect(body[0].text).toBe("Notify Nest");
    expect(body[0].weight).toBe("Bolder");
    expect(cardText(msg!.payload)).toContain("write");
    // The :key: shortcode sharing-service uses is translated for Teams.
    expect(cardText(msg!.payload)).toContain("🔑");
    expect(cardText(msg!.payload)).not.toContain(":key:");
    // Plain-text fallback for clients that can't render the card.
    expect(msg!.payload.attachments[0].content.fallbackText).toContain(
      "bob@acme.com",
    );
  });

  it("a per-nest channel:'teams' connector row receives an Adaptive Card; the implicit global connector stays silent for review events", async () => {
    const create = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/connectors`,
      { channel: "teams", url: ROW_URL, events: ["review_requested"] },
      alice.apiKey,
    );
    expect(create.status).toBe(201);

    const globalBefore = sent.length;
    rowSent.length = 0;
    await dispatchEvent({
      kind: "review_requested",
      nestId,
      message: "Review requested on *Doc* by alice@acme.com",
    });
    await settle();

    // The row got the same Adaptive Card wire format as the global connector.
    expect(rowSent).toHaveLength(1);
    expectAdaptiveCardEnvelope(rowSent[0]);
    const body = rowSent[0].attachments[0].content.body;
    expect(body[0].text).toBe("Notify Nest");
    expect(cardText(rowSent[0])).toContain("📝");
    expect(cardText(rowSent[0])).toContain("**Doc**");
    // Review events reach the global MSTEAMS_WEBHOOK_URL via the debounced
    // digest path (notifyNestEvent), so dispatchEvent's implicit connector
    // must NOT also post them — that would be the double-delivery the digest
    // suppression exists to prevent. Connector rows are dispatch-only, so
    // the row above still fires.
    expect(sent.length).toBe(globalBefore);
  });

  it("does not post (and does not fail) when the webhook is unset", async () => {
    delete process.env.MSTEAMS_WEBHOOK_URL;
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
    process.env.MSTEAMS_WEBHOOK_URL = WEBHOOK;
  });

  it("a failing webhook never breaks the governance action", async () => {
    process.env.MSTEAMS_WEBHOOK_URL = "https://prod-99.westus.logic.azure.com/workflows/dead/end";
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "dave@acme.com", permission: "read" },
      alice.apiKey,
    );
    // Stub throws for unknown logic.azure.com URLs — the API call itself
    // must still succeed (fire-and-forget contract).
    expect(res.status).toBe(201);
    process.env.MSTEAMS_WEBHOOK_URL = WEBHOOK;
  });

  it("a webhook answering 500 never breaks the governance action", async () => {
    const FAILING = "https://prod-02.westus.logic.azure.com/workflows/http500/invoke";
    const prevStub = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: any, init?: any) => {
      if (String(url) === FAILING) return new Response("boom", { status: 500 });
      return prevStub(url, init);
    });
    process.env.MSTEAMS_WEBHOOK_URL = FAILING;
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "erin@acme.com", permission: "read" },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    await settle();
    vi.stubGlobal("fetch", prevStub);
    process.env.MSTEAMS_WEBHOOK_URL = WEBHOOK;
  });
});

// The review lifecycle events (submit / approve / reject) each fire a Teams
// card carrying the document's title + folder and a user-controlled note.
// Self-contained (own fetch stub + webhook) so it doesn't depend on the first
// block's beforeAll/afterAll ordering — same layout as the Slack suite.
describe("Microsoft Teams connector — review lifecycle + mrkdwn translation", () => {
  let lenv: ReturnType<typeof setupTestEnv>;
  let lapp: any;
  let admin: { apiKey: string };
  let dev: { apiKey: string };
  let jane: { apiKey: string };
  let lnestId: string;

  const LWEBHOOK = "https://prod-11.westus.logic.azure.com/workflows/def/triggers/manual/paths/invoke";
  const lsent: any[] = [];
  const realFetch = globalThis.fetch;
  const settle = () => new Promise((r) => setTimeout(r, 50));

  beforeAll(async () => {
    process.env.NOTIFY_DEBOUNCE_MS = "10"; // near-instant flush; block is self-sufficient
    process.env.MSTEAMS_WEBHOOK_URL = LWEBHOOK;
    vi.stubGlobal("fetch", async (url: any, init?: any) => {
      const u = String(url);
      if (u === LWEBHOOK) {
        lsent.push(JSON.parse(init.body));
        return new Response("ok", { status: 200 });
      }
      if (u.includes("logic.azure.com")) throw new Error("simulated outage");
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
    // Drain the collaborator-add notifications fired above so they can't leak
    // into the first test's assertions via the digest buffer.
    await settle();
  }, 30000);

  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env.MSTEAMS_WEBHOOK_URL;
    delete process.env.NOTIFY_DEBOUNCE_MS;
    lenv.cleanup();
  });

  const ltext = (p: any): string =>
    (p.attachments?.[0]?.content?.body ?? []).map((b: any) => b.text).join("\n");

  // Create a draft doc inside the `api` folder, tagged so jane resolves as a
  // reviewer. Returns the node id ("nodes/api/<slug>").
  async function draft(title: string): Promise<string> {
    const res = await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes`,
      { title, content: "# body", folder: "api", tags: ["architecture"] }, dev.apiKey);
    expect(res.status).toBe(201);
    return res.data.node.id;
  }

  it("submit posts a card with the document title + folder and translated formatting", async () => {
    const id = await draft("Rate Limits");
    expect(id).toBe("nodes/api/rate-limits");

    lsent.length = 0;
    const res = await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes/${id}/submit-review`,
      { note: "please review", priority: "high" }, dev.apiKey);
    expect(res.status).toBe(201);
    await settle();

    // Exactly ONE post for one review_requested. review-service fires the
    // event down two paths — dispatchEvent (immediate) and notifyNestEvent
    // (debounced digest) — and both target the same global webhook, so
    // without dispatch.ts's DIGEST_DELIVERED_KINDS suppression this would be
    // 2. (Slack has that double-post today, pre-existing — tracked
    // separately; this pins Teams to single delivery via the digest path.)
    expect(lsent).toHaveLength(1);
    const card = lsent.find((p) => ltext(p).includes("Rate Limits"));
    expect(card).toBeTruthy();
    expect(card.type).toBe("message");
    expect(card.attachments[0].contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
    const text = ltext(card);
    // Slack shortcode is translated to a real emoji for Teams.
    expect(text).toContain("📝");
    expect(text).not.toContain(":memo:");
    // Slack *bold* becomes Adaptive Card **bold**.
    expect(text).toContain("**Rate Limits (in api)**");
    // Title, not the raw node path; folder surfaced so a reviewer has context.
    expect(text).not.toContain("nodes/api/rate-limits");
  });

  it("approve posts a card with the document title", async () => {
    const id = await draft("Approve Me");
    await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes/${id}/submit-review`, {}, dev.apiKey);
    // Drain the submit-review notification before asserting: otherwise the
    // digest debounce can merge it with (or leak it ahead of) the approve
    // event on this same nest.
    await settle();
    lsent.length = 0;
    const res = await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes/${id}/approve`,
      { note: "lgtm" }, jane.apiKey);
    expect(res.status).toBe(200);
    await settle();
    expect(lsent).toHaveLength(1); // single delivery — digest path only
    const card = lsent.find((p) => ltext(p).includes("Approve Me"));
    expect(card).toBeTruthy();
    const text = ltext(card);
    expect(text).toContain("✅");
    expect(text).toContain("**Approve Me (in api)**");
  });

  it("reject posts a card and neutralizes markdown-link syntax in the note", async () => {
    const id = await draft("Reject Me");
    await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes/${id}/submit-review`, {}, dev.apiKey);
    // Drain the submit-review notification before asserting (see approve test).
    await settle();
    lsent.length = 0;
    const res = await jsonRequest(lapp, "POST", `/nests/${lnestId}/nodes/${id}/reject`,
      { note: "[check this](https://evil.example) missing section" }, jane.apiKey);
    expect(res.status).toBe(200);
    await settle();
    expect(lsent).toHaveLength(1); // single delivery — digest path only
    const card = lsent.find((p) => ltext(p).includes("Reject Me"));
    expect(card).toBeTruthy();
    const text = ltext(card);
    expect(text).toContain("❌");
    expect(text).toContain("**Reject Me (in api)**");
    expect(text).toContain("missing section");
    // The note's [label](url) must NOT survive as live link syntax — the
    // brackets are escaped, so no trusted-looking link renders in Teams.
    expect(text).not.toContain("[check this](https://evil.example)");
    expect(text).toContain("\\[check this\\]");
  });
});

// Card-builder unit tests: escaping is the security boundary, so pin it
// directly on msTeamsPayload — every TextBlock (title AND message) must be
// link-injection-proof while the mrkdwn translation still applies.
describe("msTeamsPayload — markdown-link escaping", () => {
  const body = (p: any) => (p as any).attachments[0].content.body;

  it("a [label](url) in the message does not render as a markdown link", () => {
    const p: any = msTeamsPayload("Nest", "note: [check this](https://evil.example)");
    expect(body(p)[1].text).not.toContain("[check this](https://evil.example)");
    expect(body(p)[1].text).toContain("\\[check this\\](https://evil.example)");
  });

  it("a crafted backslash cannot un-escape the brackets", () => {
    const p: any = msTeamsPayload("Nest", "\\[x](https://evil.example)");
    // Raw \ doubles to \\, then [ becomes \[ — the bracket stays escaped.
    expect(body(p)[1].text).toContain("\\\\\\[x\\](https://evil.example)");
  });

  it("the title (nest name) goes through the same escape + translation pipeline", () => {
    const p: any = msTeamsPayload("[Evil](https://evil.example) :memo: nest", "msg");
    expect(body(p)[0].text).not.toContain("[Evil](https://evil.example)");
    expect(body(p)[0].text).toContain("\\[Evil\\]");
    // Translated, not just escaped: shortcodes become unicode in the title too.
    expect(body(p)[0].text).toContain("📝");
    expect(body(p)[0].text).not.toContain(":memo:");
  });

  it("escaping still lets *bold* and emoji translate in the message", () => {
    const p: any = msTeamsPayload("Nest", ":x: *Doc Title* rejected");
    expect(body(p)[1].text).toBe("❌ **Doc Title** rejected");
  });
});

describe("admin settings validation", () => {
  it("rejects a non-https webhook URL and accepts empty to disable", async () => {
    // Validation is what we're testing, so hit the endpoint as an admin via a
    // fresh open-mode app (same approach as the Slack suite).
    const openApp = await createTestApp("open");
    const bad = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      msteams_webhook_url: "http://insecure.example.com/hook",
    });
    expect(bad.status).toBe(400);
    expect(bad.data.fieldErrors.msteams_webhook_url).toBeTruthy();
    const clear = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      msteams_webhook_url: "",
    });
    expect(clear.status).toBe(200);
    expect(clear.data.settings.msteams_webhook_url).toBe("");
    const set = await jsonRequest(openApp, "PATCH", "/admin/settings", {
      msteams_webhook_url: WEBHOOK,
    });
    expect(set.status).toBe(200);
    expect(set.data.settings.msteams_webhook_url).toBe(WEBHOOK);
    // Leave the suite-wide value in place for any later block.
    process.env.MSTEAMS_WEBHOOK_URL = WEBHOOK;
  });
});

// Self-contained (own fetch stub) — the review-lifecycle block above unstubs
// globals in its afterAll, so this block must re-stub fetch for itself.
describe("send test notification", () => {
  const TWEBHOOK =
    "https://prod-02.westus.logic.azure.com/workflows/test/triggers/manual/paths/invoke";
  const tsent: any[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    vi.stubGlobal("fetch", async (url: any, init?: any) => {
      const u = String(url);
      if (u === TWEBHOOK) {
        tsent.push(JSON.parse(init.body));
        return new Response("ok", { status: 200 });
      }
      if (u.includes("logic.azure.com")) throw new Error("simulated outage");
      return realFetch(url, init);
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env.MSTEAMS_WEBHOOK_URL;
  });

  it("posts an Adaptive Card to the saved webhook and reports success", async () => {
    const openApp = await createTestApp("open");
    process.env.MSTEAMS_WEBHOOK_URL = TWEBHOOK;
    const before = tsent.length;
    const res = await jsonRequest(
      openApp,
      "POST",
      "/admin/settings/test-notification",
      { channel: "teams" },
    );
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    await settle();
    expect(tsent.length).toBe(before + 1);
    expectAdaptiveCardEnvelope(tsent[tsent.length - 1]);
  });

  it("returns an error (not a throw) when no webhook is configured", async () => {
    const openApp = await createTestApp("open");
    delete process.env.MSTEAMS_WEBHOOK_URL;
    const res = await jsonRequest(
      openApp,
      "POST",
      "/admin/settings/test-notification",
      { channel: "teams" },
    );
    expect(res.status).toBe(502);
    expect(res.data.error).toMatch(/webhook URL first/i);
  });

  it("rejects an unknown channel", async () => {
    const openApp = await createTestApp("open");
    const res = await jsonRequest(
      openApp,
      "POST",
      "/admin/settings/test-notification",
      { channel: "bogus" },
    );
    expect(res.status).toBe(400);
  });

  it("surfaces a webhook outage as an error", async () => {
    const openApp = await createTestApp("open");
    // A different logic.azure.com URL the fetch stub treats as an outage.
    process.env.MSTEAMS_WEBHOOK_URL =
      "https://prod-99.westus.logic.azure.com/workflows/dead/triggers/manual/paths/invoke";
    const res = await jsonRequest(
      openApp,
      "POST",
      "/admin/settings/test-notification",
      { channel: "teams" },
    );
    expect(res.status).toBe(502);
    expect(res.data.error).toBeTruthy();
  });

  it("a key-mode superadmin (not the license admin) is allowed — 403 here would be the authz bug", async () => {
    // access.yaml superadmin, no ownerEmail → superadmin but NOT license admin.
    // The route must gate on server-admin (license admin OR superadmin), the
    // same guard as GET/PATCH /admin/settings, not license-admin-only.
    const keyApp = await createTestApp("key", { superAdmins: ["super@acme.com"] });
    const superUser = await registerUser(keyApp, "super@acme.com", "Super");
    delete process.env.MSTEAMS_WEBHOOK_URL;
    const res = await jsonRequest(
      keyApp,
      "POST",
      "/admin/settings/test-notification",
      { channel: "teams" },
      superUser.apiKey,
    );
    // Authz passes (not 403); the handler then reports no webhook configured.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(502);
    expect(res.data.error).toMatch(/webhook URL first/i);
  });
});
