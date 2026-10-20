/**
 * CU-wdqcq0538g — what headless publishing (CU-wdqcq0314u) lacked:
 *   - MCP parity for the owner's controls (`context_headless`: status /
 *     enable / disable / create_key / revoke_key), gated to a person who owns
 *     or administers the nest on a full credential, re-checked on every call;
 *   - a per-key rate limit on access keys (HEADLESS_KEY_RATE_LIMIT_PER_MIN,
 *     429 + Retry-After).
 *
 * GWT: (1) admin-only advertisement, (2) a reader / editor / read-only key /
 * access key can't mint, (3) full lifecycle over MCP matches REST, (4) the
 * private-only rule holds over MCP, (5) rate limit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let admin: User;
let editor: User;
let reader: User;
let nestId: string;
let publicNestId: string;

async function mcp(
  path: string,
  method: string,
  params: Record<string, unknown>,
  key: string,
): Promise<{ httpStatus: number; body: any }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return { httpStatus: res.status, body: await res.json() };
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return { httpStatus: res.status, body: line ? JSON.parse(line.slice(6)) : { raw: text } };
}
const toolNames = async (key: string, nest = nestId): Promise<string[]> =>
  ((await mcp(`/nests/${nest}/mcp`, "tools/list", {}, key)).body?.result?.tools ?? []).map(
    (t: any) => t.name,
  );
const call = (name: string, args: Record<string, unknown>, key: string, nest = nestId) =>
  mcp(`/nests/${nest}/mcp`, "tools/call", { name, arguments: args }, key);
const text = (body: any): string =>
  body?.error?.message ?? (body?.result?.content ?? []).map((p: any) => p?.text ?? "").join("");

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@hla.test", "Owner");
  admin = await registerUser(app, "admin@hla.test", "Admin");
  await resetAuthRateLimit();
  editor = await registerUser(app, "editor@hla.test", "Editor");
  reader = await registerUser(app, "reader@hla.test", "Reader");

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Private" }, owner.apiKey)).data.nest.id;
  for (const [u, permission] of [
    [admin, "admin"],
    [editor, "write"],
    [reader, "read"],
  ] as Array<[User, string]>) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
    expect(r.status).toBe(201);
  }
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Doc", content: "hello" }, owner.apiKey);

  publicNestId = (await jsonRequest(app, "POST", "/nests", { name: "Open" }, owner.apiKey)).data.nest.id;
  const vis = await jsonRequest(
    app,
    "PATCH",
    `/nests/${publicNestId}/visibility`,
    { visibility: "public", acknowledge_public: true },
    owner.apiKey,
  );
  expect(vis.status).toBe(200);
});

afterAll(() => env.cleanup());

describe("GWT 1 — advertised to nest owners/admins only", () => {
  it("owner and nest admin see context_headless; editor and reader don't", async () => {
    expect(await toolNames(owner.apiKey)).toContain("context_headless");
    expect(await toolNames(admin.apiKey)).toContain("context_headless");
    expect(await toolNames(editor.apiKey)).not.toContain("context_headless");
    expect(await toolNames(reader.apiKey)).not.toContain("context_headless");
  });
});

describe("GWT 2 — nobody below admin can mint, whatever they call", () => {
  it("a read collaborator and an editor are refused, and nothing changes", async () => {
    // Over the transport the tool isn't even registered for them…
    for (const u of [reader, editor]) {
      const r = await call("context_headless", { action: "enable" }, u.apiKey);
      expect(text(r.body)).toMatch(/not found|admin|denied|permission/i);
    }
    // …and the service-layer re-check refuses them even when dispatched directly.
    const { handleToolCall } = await import("../src/mcp/tools.js");
    for (const u of [reader, editor]) {
      const out = (await handleToolCall("context_headless", { action: "enable" }, {
        nestId, userId: u.userId, userEmail: u.email, capability: "write",
      } as any)) as { text: string; isError?: boolean };
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/owner or admin/i);
    }
    const st = await jsonRequest(app, "GET", `/nests/${nestId}/headless`, undefined, owner.apiKey);
    expect(st.data.enabled).toBe(false);
  });

  it("the owner's own read-only key can't see or run it", async () => {
    const ro = (
      await jsonRequest(app, "POST", "/auth/keys", { label: "ro", nest_id: nestId, capability: "read" }, owner.apiKey)
    ).data.api_key;
    expect(await toolNames(ro)).not.toContain("context_headless");
    const r = await call("context_headless", { action: "enable" }, ro);
    expect(text(r.body)).toMatch(/read-only|not found/i);
    const { handleToolCall } = await import("../src/mcp/tools.js");
    const out = (await handleToolCall("context_headless", { action: "enable" }, {
      nestId, userId: owner.userId, userEmail: owner.email, capability: "read",
    } as any)) as string | { text: string };
    expect(typeof out === "string" ? out : out.text).toMatch(/read-only/i);
    // REST twin is refused for a read key too.
    const rest = await jsonRequest(app, "PUT", `/nests/${nestId}/headless`, { enabled: true }, ro);
    expect(rest.status).toBe(403);
  });
});

describe("GWT 3 — lifecycle over MCP at REST parity", () => {
  let token: string;
  let keyId: string;

  it("enable → create_key (token once) → status lists it without the token", async () => {
    const on = await call("context_headless", { action: "enable" }, owner.apiKey);
    expect(on.body.result.structuredContent).toEqual({ enabled: true });
    const rest = await jsonRequest(app, "GET", `/nests/${nestId}/headless`, undefined, owner.apiKey);
    expect(rest.data.enabled).toBe(true);

    const noLabel = await call("context_headless", { action: "create_key" }, owner.apiKey);
    expect(text(noLabel.body)).toMatch(/label/i);

    const c = await call("context_headless", { action: "create_key", label: "Buyer A" }, admin.apiKey);
    const created = c.body.result.structuredContent;
    token = created.api_key;
    keyId = created.key.id;
    expect(token).toMatch(/^cnst_/);
    expect(created.key.label).toBe("Buyer A");

    const st = await call("context_headless", { action: "status" }, owner.apiKey);
    expect(text(st.body)).toContain("Buyer A");
    expect(text(st.body)).not.toContain(token);
    const listed = await jsonRequest(app, "GET", `/nests/${nestId}/headless`, undefined, owner.apiKey);
    expect(listed.data.keys.map((k: any) => k.id)).toContain(keyId);
  });

  it("the key reads; an access key can't call the admin tool itself", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, token);
    expect(r.status).toBe(200);
    expect(await toolNames(token)).not.toContain("context_headless");
    const self = await call("context_headless", { action: "create_key", label: "self" }, token);
    expect(JSON.stringify(self.body)).not.toMatch(/cnst_[0-9a-f]{64}/);
  });

  it("disable pauses the key; revoke_key kills it", async () => {
    await call("context_headless", { action: "disable" }, owner.apiKey);
    const paused = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, token);
    expect([403, 404]).toContain(paused.status);
    await call("context_headless", { action: "enable" }, owner.apiKey);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, token)).status).toBe(200);

    const d = await call("context_headless", { action: "revoke_key", key_id: keyId }, owner.apiKey);
    expect(text(d.body)).toMatch(/revoked/i);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, token)).status).toBe(401);
    const again = await call("context_headless", { action: "revoke_key", key_id: keyId }, owner.apiKey);
    expect(text(again.body)).toMatch(/not found/i);
  });
});

describe("GWT 4 — only a private nest can be headless, over MCP too", () => {
  it("enable on a public nest is refused and leaves it off", async () => {
    const r = await call("context_headless", { action: "enable" }, owner.apiKey, publicNestId);
    expect(text(r.body)).toMatch(/private/i);
    const st = await jsonRequest(app, "GET", `/nests/${publicNestId}/headless`, undefined, owner.apiKey);
    expect(st.data.enabled).toBe(false);
  });
});

describe("GWT 5 — per-key rate limit", () => {
  let env2: ReturnType<typeof setupTestEnv>;
  afterAll(() => {
    delete process.env.HEADLESS_KEY_RATE_LIMIT_PER_MIN;
    return env2.cleanup();
  });

  it("over the limit → 429 with Retry-After; people are unaffected", async () => {
    env2 = setupTestEnv();
    process.env.HEADLESS_KEY_RATE_LIMIT_PER_MIN = "3";
    const app2 = await createTestApp("key");
    const o = await registerUser(app2, "rl@hla.test", "RL");
    const n = (await jsonRequest(app2, "POST", "/nests", { name: "RL" }, o.apiKey)).data.nest.id;
    expect((await jsonRequest(app2, "PUT", `/nests/${n}/headless`, { enabled: true }, o.apiKey)).status).toBe(200);
    const k = (await jsonRequest(app2, "POST", `/nests/${n}/headless/keys`, { label: "rl" }, o.apiKey)).data.api_key;
    for (let i = 0; i < 3; i++) {
      const ok = await app2.request(`/nests/${n}/nodes`, { headers: { Authorization: `Bearer ${k}` } });
      expect(ok.status).toBe(200);
    }
    const res = await app2.request(`/nests/${n}/nodes`, { headers: { Authorization: `Bearer ${k}` } });
    expect(res.status).toBe(429);
    const ra = Number(res.headers.get("retry-after"));
    expect(ra).toBeGreaterThan(0);
    expect(ra).toBeLessThanOrEqual(60);
    // The owner's own key is unaffected.
    const own = await jsonRequest(app2, "GET", `/nests/${n}/nodes`, undefined, o.apiKey);
    expect(own.status).toBe(200);
  });
});
