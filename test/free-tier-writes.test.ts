/**
 * Free tier: an unlicensed server accepts writes while it has 10 or fewer
 * billed users (auth/free-tier.ts). Viewers never count. Past that, the license gate closes with a
 * message that says why. A valid license allows writes at any head-count.
 *
 * Every write surface asks the same writesAllowed(), so each case below is
 * checked on all of them: REST (nest-level and nest-scoped), server-level MCP,
 * per-nest MCP, and workflow runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest, seedPeople } from "./helpers.js";
import { FREE_TIER_MAX_USERS } from "../src/auth/free-tier.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const OVER_LIMIT = /more than 10 users and no valid PromptOwl license, so writes are disabled/;

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let runId: string;
// Read by the mocked license on every call — flip `valid` mid-suite.
const overrides: Record<string, unknown> = {};

/** POST a JSON-RPC tools/call; returns the HTTP status plus the text payload
 *  (tool result text, or the JSON-RPC error message the gate sends). */
async function mcp(path: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(path, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l: string) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  const text = body.error
    ? String(body.error.message)
    : body.result.content.map((c: any) => c.text).join("");
  return { status: res.status as number, text };
}

let seq = 0;
/** Try one write on every surface; returns what each one said. */
async function writeEverywhere() {
  seq++;
  const restNest = await jsonRequest(app, "POST", "/nests", { name: `Nest ${seq}` });
  const restNode = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: `REST doc ${seq}`,
    content: "body",
  });
  const serverMcp = await mcp("/mcp", "nest_create", { name: `MCP nest ${seq}` });
  const nestMcp = await mcp(`/nests/${nestId}/mcp`, "context_create", {
    title: `MCP doc ${seq}`,
    content: "body",
  });
  const runStep = await jsonRequest(app, "POST", `/runs/${runId}/steps`, { action: "read" });
  return { restNest, restNode, serverMcp, nestMcp, runStep };
}

async function peopleCount(): Promise<number> {
  const { countBilled } = await import("../src/auth/seats.js");
  return (await countBilled()).users;
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  env = setupTestEnv();
  // Open mode: the caller is the server admin, so blocked writes carry the
  // specific reason rather than the neutral read-only line.
  app = await createTestApp("open", { licenseOverrides: overrides });
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Free tier" });
  expect(nest.status).toBe(201);
  nestId = nest.data.nest?.id ?? nest.data.id;
  const agent = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Digest Agent",
    content: "# Agent\n\nSummarize the day.",
    type: "agent",
  });
  expect(agent.status).toBe(201);
  const run = await jsonRequest(app, "POST", `/nests/${nestId}/run/nodes/digest-agent`, {});
  expect(run.status).toBe(201);
  runId = run.data.run_id;
});

afterAll(() => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  env.cleanup();
});

describe("no license, 10 or fewer people", () => {
  beforeAll(async () => {
    overrides.valid = false;
    await seedPeople(FREE_TIER_MAX_USERS - (await peopleCount()), "free");
    expect(await peopleCount()).toBe(FREE_TIER_MAX_USERS);
  });

  it("allows writes on REST, MCP (server + per-nest) and workflow runs", async () => {
    const w = await writeEverywhere();
    expect(w.restNest.status).toBe(201);
    expect(w.restNode.status).toBe(201);
    expect(w.serverMcp.status).toBe(200);
    expect(w.serverMcp.text).toMatch(/^Created nest/);
    expect(w.nestMcp.status).toBe(200);
    expect(w.nestMcp.text).not.toMatch(/licen|read-only/i);
    expect(w.runStep.status).toBe(201);
  });

  it("opens governance views too (they sit behind the same gate)", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/review-queue`);
    expect(res.status).toBe(200);
  });

  it("opens teammate management too", async () => {
    expect((await jsonRequest(app, "GET", "/auth/teammates")).status).not.toBe(503);
  });

  it("never counts viewers, so sign-ups alone can't close the gate", async () => {
    await seedPeople(FREE_TIER_MAX_USERS * 2, "viewer", { viewers: true });
    expect(await peopleCount()).toBe(FREE_TIER_MAX_USERS);
    expect((await writeEverywhere()).restNode.status).toBe(201);
  });

  it("falls back to Free when a license has ended, so writes stay open", async () => {
    overrides.reason = "expired";
    try {
      expect((await writeEverywhere()).restNode.status).toBe(201);
    } finally {
      delete overrides.reason;
    }
  });

  it("still blocks writes while PromptOwl has the server suspended", async () => {
    overrides.suspended = true;
    try {
      const w = await writeEverywhere();
      expect(w.restNode.status).toBe(503);
      expect(w.nestMcp.status).toBe(503);
    } finally {
      delete overrides.suspended;
    }
  });
});

describe("no license, 11 people", () => {
  beforeAll(async () => {
    overrides.valid = false;
    await seedPeople(1, "eleventh");
    expect(await peopleCount()).toBe(FREE_TIER_MAX_USERS + 1);
  });

  it("blocks writes on every surface, saying why", async () => {
    const w = await writeEverywhere();
    expect(w.restNest.status).toBe(503);
    expect(w.restNest.data.error).toBe("License required");
    expect(w.restNest.data.reason).toMatch(OVER_LIMIT);
    expect(w.restNode.status).toBe(503);
    expect(w.restNode.data.reason).toMatch(OVER_LIMIT);
    expect(w.serverMcp.text).toMatch(OVER_LIMIT);
    expect(w.nestMcp.status).toBe(503);
    expect(w.nestMcp.text).toMatch(OVER_LIMIT);
    expect(w.runStep.status).toBe(403);
    expect(w.runStep.data.error).toMatch(OVER_LIMIT);
  });

  it("tells the admin how to fix it", async () => {
    const res = await jsonRequest(app, "POST", "/nests", { name: "Blocked" });
    expect(res.data.reason).toContain("POST /license/install");
  });

  it("locks teammate management", async () => {
    expect((await jsonRequest(app, "GET", "/auth/teammates")).status).toBe(503);
  });

  it("keeps reads open", async () => {
    expect((await jsonRequest(app, "GET", "/nests")).status).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}`)).status).toBe(200);
  });
});

describe("valid license, any number of people", () => {
  beforeAll(async () => {
    overrides.valid = true;
    await seedPeople(40, "licensed");
    expect(await peopleCount()).toBeGreaterThan(50);
  });
  afterAll(() => {
    delete overrides.valid;
  });

  it("allows writes on every surface", async () => {
    const w = await writeEverywhere();
    expect(w.restNest.status).toBe(201);
    expect(w.restNode.status).toBe(201);
    expect(w.serverMcp.text).toMatch(/^Created nest/);
    expect(w.nestMcp.status).toBe(200);
    expect(w.nestMcp.text).not.toMatch(OVER_LIMIT);
    expect(w.runStep.status).toBe(201);
  });
});

describe("people count", () => {
  it("leaves out access-key service identities, even ones that own a nest", async () => {
    const before = await peopleCount();
    const { getDb } = await import("../src/db/client.js");
    await getDb().run(
      "INSERT INTO users (id, email, name, password_hash, is_service) VALUES (?, ?, ?, ?, 1)",
      ["svc-free-tier", "svc-free-tier@keys.local", null, "x"],
    );
    await getDb().run("INSERT INTO nests (id, user_id, name, slug) VALUES (?, ?, ?, ?)", [
      "svc-free-tier-nest", "svc-free-tier", "Service nest", "service-nest",
    ]);
    expect(await peopleCount()).toBe(before);
  });
});
