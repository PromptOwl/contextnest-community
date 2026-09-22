/**
 * Hootie in the nest (CU-wdqcq02mem) — POST /nests/:id/chat.
 *
 * The assistant answers from what the CALLER can read (the same retrieval
 * and permission gate as /context), streams the answer, and — when the
 * message names people — posts the exchange as a comment on the anchor
 * document so the mention reaches them through the comment-mention path.
 *
 * The model call is the one thing mocked: `streamAnswer` in
 * src/hootie/model.ts is replaced with a scripted generator, so every test
 * exercises the real route, retrieval, comment and notification code.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

interface SseEvent {
  event: string;
  data: any;
}

/** Parse a text/event-stream body into its events. */
function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const raw = dataLines.join("\n");
      let data: any = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        /* keep raw */
      }
      return { event, data };
    });
}

/** What the mocked model will say next; tests set it per case. */
let scriptedAnswer = "Hoot.";
/** What the mocked model was asked; tests inspect the retrieved context. */
let lastModelCall: { system: string; turns: any[] } | null = null;

async function chatRaw(
  app: any,
  nestId: string,
  body: Record<string, unknown>,
  apiKey?: string,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await app.request(`/nests/${nestId}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, res };
}

async function chat(
  app: any,
  nestId: string,
  body: Record<string, unknown>,
  apiKey?: string,
) {
  const { status, text, res } = await chatRaw(app, nestId, body, apiKey);
  const isSse = (res.headers.get("content-type") || "").includes("text/event-stream");
  return {
    status,
    events: isSse ? parseSse(text) : [],
    json: isSse ? null : safeJson(text),
  };
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The model mock is file-wide: no describe in this file may reach the SDK.
beforeAll(() => {
  vi.doMock("../src/hootie/model.js", () => ({
    streamAnswer: async function* (params: { system: string; turns: any[] }) {
      lastModelCall = { system: params.system, turns: params.turns };
      // Two chunks, so the route's delta framing is exercised.
      const mid = Math.ceil(scriptedAnswer.length / 2);
      yield scriptedAnswer.slice(0, mid);
      yield scriptedAnswer.slice(mid);
    },
  }));
});
afterAll(() => {
  vi.doUnmock("../src/hootie/model.js");
});

describe("POST /nests/:id/chat — Hootie in the nest", () => {
  let app: any;
  let owner: { apiKey: string; email: string; userId: string };
  let reader: { apiKey: string; email: string; userId: string };
  let stranger: { apiKey: string; email: string; userId: string };
  let nestId: string;
  let authNodeId: string;

  beforeAll(async () => {
    setupTestEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    delete process.env.HOOTIE_ENABLED;
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    reader = await registerUser(app, "reader@acme.com", "Reader");
    await resetAuthRateLimit();
    stranger = await registerUser(app, "stranger@acme.com", "Stranger");
    await resetAuthRateLimit();

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Hootie Nest" },
      owner.apiKey,
    );
    nestId = data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: reader.email, permission: "read" },
      owner.apiKey,
    );

    const auth = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "API Authentication Guide",
        content:
          "# API Authentication\n\nRequests authenticate with Bearer tokens minted from Settings.",
        tags: ["auth", "api"],
      },
      owner.apiKey,
    );
    authNodeId = auth.data.node.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Brand Guidelines",
        content: "# Brand\n\nLogo rules, color palette, voice.",
        tags: ["brand"],
      },
      owner.apiKey,
    );
    // Prime the engine's auto-indexer (see context-endpoint.test.ts).
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/context`,
      { selector: "#nonexistent" },
      owner.apiKey,
    );
  });

  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.HOOTIE_ENABLED;
  });

  it("streams an answer grounded in the nodes the caller can read, with citations", async () => {
    scriptedAnswer =
      "Requests use Bearer tokens — see [[API Authentication Guide]].";
    const { status, events } = await chat(
      app,
      nestId,
      { message: "how do requests authenticate?" },
      reader.apiKey,
    );
    expect(status).toBe(200);

    const meta = events.find((e) => e.event === "meta");
    expect(meta).toBeTruthy();
    expect(meta!.data.nodes.map((n: any) => n.id)).toContain(authNodeId);

    const text = events
      .filter((e) => e.event === "delta")
      .map((e) => e.data.text)
      .join("");
    expect(text).toBe(scriptedAnswer);

    const done = events.find((e) => e.event === "done");
    expect(done).toBeTruthy();
    expect(done!.data.answer).toBe(scriptedAnswer);
    expect(done!.data.cited.map((n: any) => n.id)).toEqual([authNodeId]);
    expect(done!.data.mention).toBeNull();

    // The retrieved context reached the model, and nothing was invented.
    expect(lastModelCall!.system).toContain("API Authentication Guide");
    expect(lastModelCall!.system).toContain("Bearer tokens");
    expect(lastModelCall!.turns.at(-1)).toEqual({
      role: "user",
      content: "how do requests authenticate?",
    });
  });

  it("anchors on the open document: its body is in context even when the question doesn't name it", async () => {
    scriptedAnswer = "Yes.";
    const { status, events } = await chat(
      app,
      nestId,
      { message: "is this still current?", node_id: authNodeId },
      reader.apiKey,
    );
    expect(status).toBe(200);
    const meta = events.find((e) => e.event === "meta")!;
    expect(meta.data.anchor).toEqual(
      expect.objectContaining({ id: authNodeId, title: "API Authentication Guide" }),
    );
    expect(meta.data.nodes.map((n: any) => n.id)).toContain(authNodeId);
    expect(lastModelCall!.system).toContain("Bearer tokens");
  });

  it("carries the conversation: prior turns reach the model in order", async () => {
    scriptedAnswer = "Still yes.";
    const { status } = await chat(
      app,
      nestId,
      {
        message: "and for MCP clients?",
        history: [
          { role: "user", content: "how do requests authenticate?" },
          { role: "assistant", content: "Bearer tokens." },
        ],
      },
      reader.apiKey,
    );
    expect(status).toBe(200);
    expect(lastModelCall!.turns.map((t: any) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(lastModelCall!.turns[1].content).toBe("Bearer tokens.");
  });

  it("404s for someone with no access to the nest — the nest gate applies before any model call", async () => {
    lastModelCall = null;
    const { status } = await chatRaw(
      app,
      nestId,
      { message: "what's in here?" },
      stranger.apiKey,
    );
    expect(status).toBe(404);
    expect(lastModelCall).toBeNull();
  });

  it("400s an empty message", async () => {
    const { status, json } = await chat(app, nestId, { message: "   " }, reader.apiKey);
    expect(status).toBe(400);
    expect(json.error).toMatch(/message/i);
  });

  it("@mentioning someone posts the exchange as a comment on the open document and notifies them", async () => {
    scriptedAnswer = "Tokens are minted from Settings.";
    const { status, events } = await chat(
      app,
      nestId,
      {
        message: `@${owner.email} can you confirm where tokens come from?`,
        node_id: authNodeId,
      },
      reader.apiKey,
    );
    expect(status).toBe(200);
    const done = events.find((e) => e.event === "done")!;
    expect(done.data.mention).toEqual(
      expect.objectContaining({
        status: "posted",
        node_id: authNodeId,
        node_title: "API Authentication Guide",
      }),
    );

    // The comment is on the document, authored by the asker, carries both
    // sides of the exchange, and keeps the @name so the mention resolves.
    const { data: threads } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${authNodeId}/annotations`,
      undefined,
      reader.apiKey,
    );
    const posted = threads.threads.find((t: any) =>
      t.comments[0].body.includes("Tokens are minted from Settings."),
    );
    expect(posted).toBeTruthy();
    expect(posted.comments[0].author).toBe(reader.email);
    expect(posted.comments[0].body).toContain(`@${owner.email}`);
    expect(posted.comments[0].body).toContain("can you confirm where tokens come from?");

    // …and the owner hears about it the way a comment mention reaches them.
    const { data: inbox } = await jsonRequest(
      app,
      "GET",
      "/me/notifications",
      undefined,
      owner.apiKey,
    );
    const mention = inbox.notifications.find(
      (n: any) => n.kind === "mention" && n.node_id === authNodeId,
    );
    expect(mention).toBeTruthy();
    expect(mention.message).toContain(reader.email);
  });

  it("with no open document, a mention anchors on the first node the answer cites", async () => {
    scriptedAnswer = "Brand voice is in [[Brand Guidelines]].";
    const { events } = await chat(
      app,
      nestId,
      { message: `@${owner.email} what's our brand voice?` },
      reader.apiKey,
    );
    const done = events.find((e) => e.event === "done")!;
    expect(done.data.mention.status).toBe("posted");
    expect(done.data.mention.node_title).toBe("Brand Guidelines");
  });

  it("a mention with nothing to anchor on is reported undeliverable, and no comment is posted", async () => {
    scriptedAnswer = "I couldn't find anything about that.";
    const before = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${authNodeId}/annotations`,
      undefined,
      reader.apiKey,
    );
    const { events } = await chat(
      app,
      nestId,
      { message: `@${owner.email} zzqx quantum lattice?` },
      reader.apiKey,
    );
    const done = events.find((e) => e.event === "done")!;
    expect(done.data.mention.status).toBe("undeliverable");
    const after = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${authNodeId}/annotations`,
      undefined,
      reader.apiKey,
    );
    expect(after.data.threads.length).toBe(before.data.threads.length);
  });

  it("a message with no mention posts nothing", async () => {
    scriptedAnswer = "Nothing to see.";
    const before = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${authNodeId}/annotations`,
      undefined,
      reader.apiKey,
    );
    await chat(app, nestId, { message: "summarise this", node_id: authNodeId }, reader.apiKey);
    const after = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${authNodeId}/annotations`,
      undefined,
      reader.apiKey,
    );
    expect(after.data.threads.length).toBe(before.data.threads.length);
  });
});

describe("POST /nests/:id/chat — gates", () => {
  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.HOOTIE_ENABLED;
  });

  it("503s with a reason when the server has no Anthropic key, and never calls out", async () => {
    setupTestEnv();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.HOOTIE_ENABLED;
    lastModelCall = null;
    const app = await createTestApp("open");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Keyless" });
    const { status, json } = await chat(app, data.nest.id, { message: "hi" });
    expect(status).toBe(503);
    expect(json.reason).toBe("no_api_key");
    expect(lastModelCall).toBeNull();
  });

  it("404s when Hootie is switched off, and /health says so", async () => {
    setupTestEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.HOOTIE_ENABLED = "false";
    const app = await createTestApp("open");
    const health = await app.request("/health");
    expect((await health.json()).hootie_enabled).toBe(false);
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Off" });
    const { status } = await chatRaw(app, data.nest.id, { message: "hi" });
    expect(status).toBe(404);
  });

  it("caps how many questions one person can ask in a window — a looping client hits 429", async () => {
    setupTestEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    delete process.env.HOOTIE_ENABLED;
    const app = await createTestApp("key");
    const user = await registerUser(app, "busy@acme.com");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Busy" }, user.apiKey);
    const { CHAT_BUDGET } = await import("../src/hootie/routes.js");
    scriptedAnswer = "ok";
    for (let i = 0; i < CHAT_BUDGET.max; i++) {
      const { status } = await chatRaw(app, data.nest.id, { message: `q${i}` }, user.apiKey);
      expect(status).toBe(200);
    }
    const { status, json } = await chat(app, data.nest.id, { message: "one more" }, user.apiKey);
    expect(status).toBe(429);
    expect(json.error).toMatch(/too many/i);
  });

  it("/health reports hootie_enabled true by default", async () => {
    setupTestEnv();
    delete process.env.HOOTIE_ENABLED;
    const app = await createTestApp("open");
    const health = await (await app.request("/health")).json();
    expect(health.hootie_enabled).toBe(true);
  });
});

describe("/admin/settings — hootie_enabled toggle", () => {
  const OWNER = "admin@acme.com";

  afterAll(() => {
    delete process.env.HOOTIE_ENABLED;
  });

  it("round-trips through PATCH and shows up on /health", async () => {
    setupTestEnv();
    delete process.env.HOOTIE_ENABLED;
    const app = await createTestApp("key", { ownerEmail: OWNER });
    const admin = await registerUser(app, OWNER);

    const before = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(before.status).toBe(200);
    expect(before.data.hootie_enabled).toBe(true);

    const off = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { hootie_enabled: false },
      admin.apiKey,
    );
    expect(off.status).toBe(200);
    expect(off.data.settings.hootie_enabled).toBe(false);
    expect((await (await app.request("/health")).json()).hootie_enabled).toBe(false);

    const on = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { hootie_enabled: true },
      admin.apiKey,
    );
    expect(on.data.settings.hootie_enabled).toBe(true);
    expect((await (await app.request("/health")).json()).hootie_enabled).toBe(true);
  });
});
