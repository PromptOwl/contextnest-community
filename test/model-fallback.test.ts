/**
 * po-1419: a model call on an own key (a nest's key, or the server's own
 * gateway) that fails for a reason about the account or the endpoint is
 * retried ONCE on PromptOwl's licence gateway.
 *
 * Real Anthropic SDK, real createTurn (metacognition, the watcher, the
 * Surfaces judge) and real streamRound (Hootie, ask-nest), against stub model
 * servers in this process: "/own" plays the customer's gateway, "/po"
 * PromptOwl's. Nothing leaves 127.0.0.1.
 *
 *  - triggers: billing (400 credit balance, 402, 429 quota), 401, 403, 429
 *    after the SDK's retries, 500, 529, no connection
 *  - non-triggers: a request-shaped 400, 404, 413, 422; a primary that is
 *    already PromptOwl's; no licence gateway; the setting off
 *  - the pair rule: PromptOwl's gateway never sees the own key
 *  - a route is sticky: after one fallback the run stays on PromptOwl's
 *  - attribution: TurnResult.model_route and the trace line
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setupTestEnv, createTestApp } from "./helpers";

const OWN_KEY = "sk-own-gateway-SECRET-0001";
const PO_KEY = "sk-po-licence-0002";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "ok" | "sse";
interface Seen {
  side: "own" | "po";
  headers: IncomingMessage["headers"];
  body: any;
}

const seen: Seen[] = [];
let reply: Record<"own" | "po", (body: any) => Reply> = { own: () => "ok", po: () => "ok" };
let server: Server;
let base = "";

function messageBody(model: string, text: string) {
  return {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

function sse(model: string, text: string): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    ev("message_start", { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 } } }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }),
    ev("message_stop", { type: "message_stop" }),
  ].join("");
}

/** An Anthropic-shaped error reply. `retry-after-ms` keeps the SDK's own retries fast. */
const fail = (status: number, message: string, type = "invalid_request_error"): Reply => ({
  status,
  body: { type: "error", error: { type, message } },
  headers: { "retry-after-ms": "1" },
});
const CREDIT = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const side: "own" | "po" = req.url!.startsWith("/po/") ? "po" : "own";
      let body: any = null;
      try {
        body = JSON.parse(raw || "null");
      } catch {
        /* not JSON */
      }
      seen.push({ side, headers: req.headers, body });
      const r = reply[side](body);
      if (r === "ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(messageBody(body?.model ?? "m", `from ${side}`)));
      } else if (r === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(body?.model ?? "m", `streamed from ${side}`));
      } else {
        res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
        res.end(JSON.stringify(r.body ?? {}));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let env: ReturnType<typeof setupTestEnv> | null = null;
afterEach(() => {
  seen.length = 0;
  reply = { own: () => "ok", po: () => "ok" };
  delete process.env.MODEL_FALLBACK_PROMPTOWL;
  vi.restoreAllMocks();
});
afterAll(() => env?.cleanup());

async function boot(opts: { gateway?: boolean } = {}) {
  env?.cleanup();
  env = setupTestEnv();
  await createTestApp("key", {
    features: ["byok"],
    gateway: opts.gateway === false ? null : { baseUrl: `${base}/po`, key: PO_KEY, defaultModel: "default-claude/claude-sonnet-5" },
  });
  const model = await import("../src/metacognition/model.js");
  const hootie = await import("../src/hootie/model.js");
  const route = await import("../src/shared/model-route.js");
  return { ...model, streamRound: hootie.streamRound, ...route };
}

const own = () => ({ apiKey: OWN_KEY, baseUrl: `${base}/own`, source: "own" as const, defaultModel: null });
const request = { model: "claude-sonnet-5", system: "You judge.", messages: [{ role: "user" as const, content: "hi" }], tools: [], max_tokens: 256 };

/** Every byte PromptOwl's stub received, for the pair rule. */
const poBytes = () => JSON.stringify(seen.filter((s) => s.side === "po"));

describe("createTurn: fallback triggers", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    m = await boot();
  });

  const triggers: Array<[string, () => Reply, string, number]> = [
    ["400 credit balance (Anthropic, out of credit)", () => fail(400, CREDIT), "model_billing", 1],
    ["400 credit balance via LiteLLM", () => fail(400, `litellm.BadRequestError: AnthropicException - ${CREDIT}`), "model_billing", 1],
    ["402 payment required", () => fail(402, "Payment Required", "billing_error"), "model_billing", 1],
    ["401 key refused", () => fail(401, "invalid x-api-key", "authentication_error"), "model_auth", 1],
    ["403 forbidden", () => fail(403, "forbidden", "permission_error"), "model_auth", 1],
    // The SDK retries 429 and 5xx twice itself: the fallback comes after.
    ["429 rate limit (after the SDK's retries)", () => fail(429, "rate limited", "rate_limit_error"), "model_rate_limited", 3],
    ["500 server error", () => fail(500, "boom", "api_error"), "model_error", 3],
    ["529 overloaded", () => fail(529, "Overloaded", "overloaded_error"), "model_error", 3],
  ];
  for (const [label, r, code, ownCalls] of triggers) {
    it(`${label} → retried once on PromptOwl's gateway (${code})`, async () => {
      reply.own = r;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await m.createTurn({ credential: own(), request });
      expect((res.content[0] as any).text).toBe("from po");
      expect(res.model_route).toMatchObject({ source: "promptowl", fallback: code, model: "default-claude/claude-sonnet-5" });
      expect(res.model_route!.note).toBe(`answered via PromptOwl gateway (fallback: ${code})`);
      expect(seen.filter((s) => s.side === "own")).toHaveLength(ownCalls);
      const po = seen.filter((s) => s.side === "po");
      expect(po).toHaveLength(1);
      // The pair rule: PromptOwl's key and team model, and nothing of the own key.
      expect(po[0].headers["x-api-key"]).toBe(PO_KEY);
      expect(po[0].body.model).toBe("default-claude/claude-sonnet-5");
      expect(poBytes()).not.toContain(OWN_KEY);
      // Logged: reason and status, the key by its last 4 characters only.
      const line = warn.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("[model-route]"))!;
      expect(line).toContain(`reason=${code}`);
      expect(line).not.toContain(OWN_KEY);
      expect(line).not.toMatch(/credit balance/i);
    });
  }

  it("no connection to the own gateway → retried once on PromptOwl's gateway (model_error)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await m.createTurn({ credential: { ...own(), baseUrl: "http://127.0.0.1:1" }, request });
    expect(res.model_route?.fallback).toBe("model_error");
    expect((res.content[0] as any).text).toBe("from po");
    expect(poBytes()).not.toContain(OWN_KEY);
  }, 20_000);
});

describe("createTurn: no fallback", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    m = await boot();
  });

  const nonTriggers: Array<[string, () => Reply, number]> = [
    ["400 about the request", () => fail(400, "messages: roles must alternate between \"user\" and \"assistant\""), 400],
    ["400 unknown parameter", () => fail(400, "tools.0.input_schema: Field required"), 400],
    ["404 model not found", () => fail(404, "model: claude-nope", "not_found_error"), 404],
    ["413 too large", () => fail(413, "Request too large", "request_too_large"), 413],
    ["422 unprocessable", () => fail(422, "unprocessable"), 422],
  ];
  for (const [label, r, status] of nonTriggers) {
    it(`${label}: the error stands, PromptOwl is never asked`, async () => {
      reply.own = r;
      await expect(m.createTurn({ credential: own(), request })).rejects.toMatchObject({ status });
      expect(seen.filter((s) => s.side === "po")).toHaveLength(0);
    });
  }

  it("model_fallback_promptowl off: an out-of-credit own key fails, PromptOwl is never asked", async () => {
    process.env.MODEL_FALLBACK_PROMPTOWL = "false";
    reply.own = () => fail(400, CREDIT);
    await expect(m.createTurn({ credential: own(), request })).rejects.toMatchObject({ status: 400 });
    expect(seen.filter((s) => s.side === "po")).toHaveLength(0);
  });

  it("a primary that is already PromptOwl's has nothing to fall back to", async () => {
    reply.po = () => fail(400, CREDIT);
    const po = { apiKey: PO_KEY, baseUrl: `${base}/po`, source: "promptowl" as const, defaultModel: null };
    await expect(m.createTurn({ credential: po, request })).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(1);
  });

  it("our own abort never falls back", async () => {
    reply.own = () => fail(500, "boom", "api_error");
    const ac = new AbortController();
    ac.abort();
    await expect(m.createTurn({ credential: own(), request, signal: ac.signal })).rejects.toBeTruthy();
    expect(seen.filter((s) => s.side === "po")).toHaveLength(0);
  });
});

describe("no licence gateway", () => {
  it("an own key that fails has nowhere to go: the error stands", async () => {
    const m = await boot({ gateway: false });
    reply.own = () => fail(400, CREDIT);
    await expect(m.createTurn({ credential: own(), request })).rejects.toMatchObject({ status: 400 });
    expect(seen.filter((s) => s.side === "po")).toHaveLength(0);
  });
});

describe("a run's route", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    m = await boot();
  });

  it("is sticky: after one fallback, the next turns go straight to PromptOwl's gateway", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    reply.own = () => fail(400, CREDIT);
    const route = new m.ModelRoute(own(), "claude-sonnet-5");
    await m.createTurn({ credential: own(), route, request });
    await m.createTurn({ credential: own(), route, request });
    await m.createTurn({ credential: own(), route, request });
    expect(seen.map((s) => s.side)).toEqual(["own", "po", "po", "po"]);
    expect(route.billing()).toBe("promptowl_credits");
    expect(route.trace()).toEqual({
      model_route: { source: "promptowl", fallback: "model_billing", status: 400, model: "default-claude/claude-sonnet-5", note: "answered via PromptOwl gateway (fallback: model_billing)" },
    });
  });

  it("falls back once at most: PromptOwl failing too is the error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    reply.own = () => fail(400, CREDIT);
    reply.po = () => fail(401, "bad licence key", "authentication_error");
    await expect(m.createTurn({ credential: own(), request })).rejects.toMatchObject({ status: 401 });
    expect(seen.map((s) => s.side)).toEqual(["own", "po"]);
  });

  it("without a fallback the trace adds nothing, and billing stays own_key", async () => {
    const route = new m.ModelRoute(own(), "claude-sonnet-5");
    const res = await m.createTurn({ credential: own(), route, request });
    expect(res.model_route).toBeUndefined();
    expect(route.trace()).toEqual({});
    expect(route.billing()).toBe("own_key");
  });
});

describe("Hootie's streamed round through the route", () => {
  let m: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    m = await boot();
  });

  async function drain(gen: AsyncGenerator<string, unknown>) {
    let text = "";
    for (;;) {
      const n = await gen.next();
      if (n.done) return { text, result: n.value };
      text += n.value;
    }
  }

  it("an out-of-credit own key with tools: one own call (not a tools refusal), then PromptOwl streams the answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    reply.own = () => fail(400, CREDIT);
    reply.po = () => "sse";
    const route = new m.ModelRoute(own(), "claude-sonnet-5");
    const out = await drain(
      route.stream((c, model) =>
        m.streamRound({
          apiKey: c.apiKey,
          baseUrl: c.baseUrl,
          model,
          system: "s",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ name: "search_nest", description: "search", input_schema: { type: "object", properties: {} } }],
          toolChoice: "auto",
        }),
      ),
    );
    expect(out.text).toBe("streamed from po");
    expect(seen.filter((s) => s.side === "own")).toHaveLength(1);
    expect(route.fallback?.fallback).toBe("model_billing");
    expect(poBytes()).not.toContain(OWN_KEY);
  });

  it("text already streamed: a later failure is not retried elsewhere", async () => {
    const route = new m.ModelRoute(own(), "claude-sonnet-5");
    async function* halfThenFail(): AsyncGenerator<string, string> {
      yield "half an answer";
      throw Object.assign(new Error("overloaded"), { status: 529 });
    }
    const gen = route.stream(() => halfThenFail());
    await expect(drain(gen)).rejects.toMatchObject({ status: 529 });
    expect(route.fallback).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe("the run bundle (runner fallback)", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it("on the server's own gateway, the bundle carries PromptOwl's gateway as a separate pair; off or on PromptOwl's key, it doesn't", async () => {
    await boot();
    const { envValues } = await import("../src/workflow/env-routes.js");
    process.env.ANTHROPIC_API_KEY = OWN_KEY;
    process.env.ANTHROPIC_BASE_URL = `${base}/own`;
    const env = await envValues("no-such-nest");
    expect(env).toMatchObject({ ANTHROPIC_API_KEY: OWN_KEY, ANTHROPIC_BASE_URL: `${base}/own`, PROMPTOWL_GATEWAY_URL: `${base}/po`, PROMPTOWL_GATEWAY_KEY: PO_KEY });
    process.env.MODEL_FALLBACK_PROMPTOWL = "false";
    expect(await envValues("no-such-nest")).not.toHaveProperty("PROMPTOWL_GATEWAY_KEY");
    delete process.env.MODEL_FALLBACK_PROMPTOWL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    const po = await envValues("no-such-nest");
    expect(po.ANTHROPIC_API_KEY).toBe(PO_KEY);
    expect(po).not.toHaveProperty("PROMPTOWL_GATEWAY_KEY");
  });
});

describe("fallbackReason: the trigger table", () => {
  it("matches the judge's reason codes, and leaves request errors and our own errors alone", async () => {
    const { fallbackReason, modelFailureCode } = await import("../src/shared/model-route.js");
    const err = (status: number | undefined, message = "x", name?: string) =>
      Object.assign(new Error(message), status ? { status } : {}, name ? { name } : {});
    const table: Array<[unknown, string | null]> = [
      [err(400, CREDIT), "model_billing"],
      [err(429, "You exceeded your current quota, please check your plan and billing details"), "model_billing"],
      [err(402), "model_billing"],
      [err(401), "model_auth"],
      [err(403), "model_auth"],
      [err(429, "slow down"), "model_rate_limited"],
      [err(500), "model_error"],
      [err(502), "model_error"],
      [err(529), "model_error"],
      [err(undefined, "Connection error.", "APIConnectionError"), "model_error"],
      [err(undefined, "Request timed out.", "APIConnectionTimeoutError"), "model_timeout"],
      [err(400, "messages: roles must alternate"), null],
      [err(404), null],
      [err(413), null],
      [err(422), null],
      [err(undefined, "aborted", "APIUserAbortError"), null],
      [err(undefined, "aborted", "AbortError"), null],
      [err(undefined, "The model refused the request with tools.", "ToolsRejectedError"), null],
      [err(undefined, "The model declined to answer that.", "ModelRefusedError"), null],
      [new TypeError("Cannot read properties of undefined"), null],
    ];
    for (const [e, want] of table) {
      expect(fallbackReason(e), String((e as Error).message)).toBe(want);
      // Every fallback reason is the code the Surfaces ledger would have written.
      if (want) expect(modelFailureCode(e)).toBe(want);
    }
  });
});
