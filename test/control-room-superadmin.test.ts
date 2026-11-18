/**
 * po-1406 — the Control room is for superadmins only (Misha, 2026-11-18),
 * replacing the 2026-11-09 rule that let nest owners and admins in (po-1186
 * CR2, decision 3). Since first-run onboarding every user owns a nest, so that
 * rule showed the page to everyone.
 *
 * The REST reads that only serve the Control room page refuse anyone who is
 * not a superadmin. A key scoped to one nest is an agent reading its own nest,
 * and keeps working, as does every agent reporting route and MCP tool.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
type U = { apiKey: string; userId: string; email: string };
let root: U; // superadmin
let olive: U; // owns a nest, not a superadmin
let N: string; // olive's nest
let agentKey: string; // olive's key scoped to N, write access (the agent)

const DENIED = "Only a superadmin can open the Control room.";

async function req(method: string, path: string, body: unknown, key: string, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function mcp(nestId: string, key: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  const text: string = body?.result?.content?.[0]?.text ?? JSON.stringify(body);
  try {
    return { isError: !!body?.result?.isError, data: JSON.parse(text) };
  } catch {
    return { isError: !!body?.result?.isError, data: null, text };
  }
}

/** Every REST read the Control room page makes that nothing else does. */
const pageOnly = () => [
  "/ledger",
  "/rollups",
  "/ledger/any-entry",
  `/nests/${N}/ledger`,
  `/nests/${N}/ledger/export?format=csv`,
  `/nests/${N}/rollups`,
  "/surfaces/cold-start",
  `/surfaces/cold-start?nest_id=${N}`,
];

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.FEATURE_SURFACES = "true";
  process.env.SURFACES_BUFFER_KEY = "a".repeat(64);
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@crsa.test"] });
  root = await registerUser(app, "root@crsa.test", "Root");
  await resetAuthRateLimit();
  olive = await registerUser(app, "olive@crsa.test", "Olive");
  await resetAuthRateLimit();
  N = (await jsonRequest(app, "POST", "/nests", { name: "Olive's nest" }, olive.apiKey)).data.nest.id;
  agentKey = (await jsonRequest(app, "POST", "/auth/keys", { label: "olive-agent", nest_id: N }, olive.apiKey)).data.api_key;
});

afterAll(async () => {
  for (const k of ["FEATURE_WORKFLOW_PLANE", "FEATURE_METACOGNITION", "FEATURE_SURFACES", "SURFACES_BUFFER_KEY"]) delete process.env[k];
  await env?.cleanup();
});

beforeEach(async () => {
  await resetAuthRateLimit();
});

describe("po-1406: the Control room's page-only reads are superadmin-only", () => {
  it("AC-4: a nest owner who is not a superadmin is refused by every page-only read (403), even on their own nest", async () => {
    for (const path of pageOnly()) {
      const r = await req("GET", path, undefined, olive.apiKey);
      expect(r.status, `GET ${path} as a nest owner`).toBe(403);
      expect(String(r.data?.error ?? ""), `GET ${path}`).toContain(DENIED);
    }
  });

  it("AC-7: a superadmin reads them as before", async () => {
    for (const path of ["/ledger", "/rollups", `/nests/${N}/ledger`, `/nests/${N}/ledger/export?format=csv`, `/nests/${N}/rollups`, "/surfaces/cold-start"]) {
      const r = await req("GET", path, undefined, root.apiKey);
      expect(r.status, `GET ${path} as a superadmin`).toBe(200);
    }
  });

  it("AC-5: an agent on the owner's nest-scoped key still registers, reports a run, and reads its own nest's ledger over REST and MCP", async () => {
    const reg = await req("POST", `/nests/${N}/agents`, { name: "Olive's agent", runtime: "claude-code" }, agentKey);
    expect(reg.status).toBe(201);
    const start = await req("POST", `/nests/${N}/run/${reg.data.node_id}`, { report_only: true, external_ref: "s1" }, agentKey, { "Idempotency-Key": "crsa-s1" });
    expect(start.status).toBe(201);
    const runId = start.data.run_id;
    const step = await req("POST", `/runs/${runId}/steps`, { action: "decision", detail: { verdict: "no_op", reason_code: "duplicate" } }, agentKey, { "Idempotency-Key": "crsa-s1-d1" });
    expect(step.status).toBe(201);
    expect((await req("PATCH", `/runs/${runId}`, { status: "succeeded" }, agentKey)).status).toBe(200);

    const ledger = await req("GET", `/nests/${N}/ledger`, undefined, agentKey);
    expect(ledger.status).toBe(200);
    expect(JSON.stringify(ledger.data)).toContain(runId);
    expect((await req("GET", `/nests/${N}/rollups`, undefined, agentKey)).status).toBe(200);

    const viaMcp = await mcp(N, agentKey, "context_agent_ledger", {});
    expect(viaMcp.isError).toBe(false);
    expect(JSON.stringify(viaMcp.data)).toContain(runId);
    // The owner's own MCP session on the nest reads it too: MCP is the agent surface.
    expect((await mcp(N, olive.apiKey, "context_agent_ledger", {})).isError).toBe(false);
  });
});
