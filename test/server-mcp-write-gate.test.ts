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
async function buildApp(licenseMock?: () => Record<string, unknown>) {
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
  await seedPeople(FREE_TIER_MAX_USERS + 1);
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
