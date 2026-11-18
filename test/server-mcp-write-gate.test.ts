/**
 * Server-level /mcp bootstrap writes (nest_create, context_create) must honor
 * the SAME suspend kill-switch and license gate the per-nest write path
 * enforces. The top-level /mcp route has no suspend/license middleware, so the
 * gate lives inside handleServerToolCall — this suite proves it closes.
 *
 * Reads (nest_index) stay open when unlicensed/suspended, matching REST.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, seedPeople } from "./helpers";
import { FREE_TIER_MAX_USERS } from "../src/auth/free-tier.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function callServerTool(
  app: any,
  name: string,
  args: Record<string, unknown> = {},
  id = 1,
): Promise<string> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l: string) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  expect(body.error).toBeUndefined();
  return body.result.content.map((c: any) => c.text).join("");
}

// Open mode so no auth fixtures are needed — the write gate sits before any
// permission/nest resolution, so no nest has to exist for it to fire.
async function buildApp(licenseMock?: () => Record<string, unknown>, people = FREE_TIER_MAX_USERS + 1) {
  process.env.AUTH_MODE = "open";
  vi.resetModules();
  if (licenseMock) {
    vi.doMock("../src/auth/license.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/auth/license.js")
      >("../src/auth/license.js");
      return { ...actual, ...licenseMock() };
    });
  } else {
    // No mock → real module with no PROMPTOWL_KEY → unlicensed.
    vi.doUnmock("../src/auth/license.js");
  }
  const dbClient = await import("../src/db/client.js");
  await dbClient.resetDb();
  await dbClient.initDb();
  // Past the Free tier, so the unlicensed gate closes.
  await seedPeople(people);
  const { createApp } = await import("../src/app.js");
  return createApp();
}

describe("server-level /mcp write gate — unlicensed, past the Free tier", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await buildApp(); // real module, no license
  });
  afterAll(() => env.cleanup());

  it("blocks nest_create with the license message", async () => {
    const out = await callServerTool(app, "nest_create", { name: "X" });
    expect(out).toContain("no valid PromptOwl license");
    expect(out).toContain("more than 10 users");
  });

  it("blocks context_create with the license message", async () => {
    const out = await callServerTool(
      app,
      "context_create",
      { nest: "whatever", title: "T", content: "C" },
      2,
    );
    expect(out).toContain("no valid PromptOwl license");
  });

  it("still serves the read tool (nest_index) unlicensed", async () => {
    const out = await callServerTool(app, "nest_index", {}, 3);
    // Any non-error tool result — reads stay open, no license string.
    expect(out).not.toContain("no valid PromptOwl license");
  });
});

describe("server-level /mcp write gate — suspended", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    // Valid license but the kill-switch is engaged.
    app = await buildApp(() => ({
      getCurrentLicense: () => ({ valid: true, tier: "test", suspended: true }),
      isSuspended: () => true,
      getSuspensionReason: () => "tos",
    }));
  });
  afterAll(() => env.cleanup());

  it("blocks nest_create with the suspension message", async () => {
    const out = await callServerTool(app, "nest_create", { name: "X" });
    expect(out).toContain("suspended by PromptOwl");
    expect(out).toContain("tos");
  });

  it("blocks context_create with the suspension message", async () => {
    const out = await callServerTool(
      app,
      "context_create",
      { nest: "whatever", title: "T", content: "C" },
      2,
    );
    expect(out).toContain("suspended by PromptOwl");
  });
});

// po-1375: the version-history reads REST licenses (GET /me/stream and
// GET …/versions answer 503 through readOnlyDenial when the license is not
// valid and the server is past the Free tier) are licensed on the
// server-level /mcp too. The per-nest /nests/:id/mcp already sits behind the
// nest gate.
describe("server-level /mcp licensed reads — unlicensed, past the Free tier", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
    app = await buildApp();
  });
  afterAll(() => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    env.cleanup();
  });

  it("refuses context_stream across nests with the license message, like GET /me/stream's 503", async () => {
    const out = await callServerTool(app, "context_stream", {}, 10);
    expect(out).toContain("no valid PromptOwl license");
  });

  it("refuses context_stream for one nest the same way", async () => {
    const out = await callServerTool(app, "context_stream", { nest: "whatever" }, 11);
    expect(out).toContain("no valid PromptOwl license");
  });

  it("refuses context_versions, like GET …/versions", async () => {
    const out = await callServerTool(app, "context_versions", { nest: "whatever", title: "T" }, 12);
    expect(out).toContain("no valid PromptOwl license");
  });

  it("every gated tool's REST twin is refused the same way (503), so the two lists stay in step", async () => {
    const { SERVER_LICENSED_READ_TOOLS } = await import("../src/mcp/server-routes.js");
    const nest = (await (await app.request("/nests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Gated" }) })).json()).nest?.id;
    // A gated MCP tool must name the REST read it mirrors here; a new one fails until it does.
    const restTwin: Record<string, string> = {
      context_stream: "/me/stream",
      context_versions: `/nests/${nest ?? "x"}/nodes/nodes/any/versions`,
    };
    expect([...SERVER_LICENSED_READ_TOOLS].sort()).toEqual(Object.keys(restTwin).sort());
    for (const [tool, path] of Object.entries(restTwin)) {
      const res = await app.request(path);
      expect(res.status, `${tool} → GET ${path}`).toBe(503);
    }
  });
});

describe("server-level /mcp licensed reads — unlicensed and suspended", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
    app = await buildApp(() => ({
      getCurrentLicense: () => ({ valid: false, tier: "none" }),
      isSuspended: () => true,
      getSuspensionReason: () => "tos",
    }));
  });
  afterAll(() => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    env.cleanup();
  });

  it("words the refusal for a read, not a write", async () => {
    const out = await callServerTool(app, "context_versions", { nest: "whatever", title: "T" }, 40);
    expect(out).toContain("suspended by PromptOwl; version history is unavailable");
    expect(out).toContain("tos");
    expect(out).not.toContain("writes are blocked");
  });
});

describe("server-level /mcp licensed reads — licensed", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
    app = await buildApp(() => ({
      getCurrentLicense: () => ({ valid: true, tier: "test" }),
      isSuspended: () => false,
    }));
  });
  afterAll(() => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    env.cleanup();
  });

  it("still serves context_stream", async () => {
    const out = await callServerTool(app, "context_stream", {}, 20);
    expect(out).not.toContain("license");
    expect(out).toMatch(/stream is empty|# Stream/);
  });
});

describe("server-level /mcp licensed reads — unlicensed, within the Free tier", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.EXPERIMENTAL_DOC_STREAM = "true";
    app = await buildApp(undefined, 1); // real module, no license, one person
  });
  afterAll(() => {
    delete process.env.EXPERIMENTAL_DOC_STREAM;
    env.cleanup();
  });

  it("serves context_stream, as GET /me/stream answers 200 (licensedReadsAllowed: writes are allowed)", async () => {
    const { licensedReadsAllowed } = await import("../src/auth/free-tier.js");
    expect(await licensedReadsAllowed()).toBe(true);
    const out = await callServerTool(app, "context_stream", {}, 30);
    expect(out).not.toContain("license");
    expect(out).toMatch(/stream is empty|# Stream/);
  });
});
