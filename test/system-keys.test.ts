/**
 * CU-wdqcq0538g — named system keys and the MCP admin tools for headless
 * publishing (CU-wdqcq0314u) + systems.
 *
 * A system is a SERVICE identity (users.is_service = 1, plus a system_accounts
 * row): no password, no sessions, no OIDC. Unlike a headless access key it is
 * NOT clamped to the reader allowlist: it is a collaborator (read → viewer,
 * write → editor) on the nests an admin granted, owned by those nests rather
 * than its creator.
 *
 * GWT coverage: 8 (create), 9 (provenance + approval flow), 10 (ungranted
 * nest), 11 (login/session/key-mint refused), 12 (creator removed), 13 (list /
 * revoke / rotate / add+remove nests), 14 (not a seat), 15 (MCP parity).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let creator: { apiKey: string; userId: string; email: string };
let editor: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };
let serverAdmin: { apiKey: string; userId: string; email: string };
let nestA: string; // governed; system gets write
let nestB: string; // system gets write
let nestC: string; // not granted
let systemId: string;
let systemKey: string;
let systemEmail: string;
let humansBefore: number;

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
  let body: any = null;
  if (ct.includes("application/json")) body = await res.json();
  else {
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    body = line ? JSON.parse(line.slice("data: ".length)) : { raw: text };
  }
  return { httpStatus: res.status, body };
}
const resultText = (body: any): string =>
  (body?.result?.content ?? []).map((p: any) => p?.text ?? "").join("");
const callTool = (nest: string, name: string, args: Record<string, unknown>, key: string) =>
  mcp(`/nests/${nest}/mcp`, "tools/call", { name, arguments: args }, key);

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@sys.test"] });
  owner = await registerUser(app, "owner@sys.test", "Owner");
  creator = await registerUser(app, "creator@sys.test", "Creator");
  editor = await registerUser(app, "editor@sys.test", "Editor");
  await resetAuthRateLimit();
  outsider = await registerUser(app, "outsider@sys.test", "Outsider");
  serverAdmin = await registerUser(app, "root@sys.test", "Root");

  nestA = (await jsonRequest(app, "POST", "/nests", { name: "Alpha" }, owner.apiKey)).data.nest.id;
  nestB = (await jsonRequest(app, "POST", "/nests", { name: "Beta" }, owner.apiKey)).data.nest.id;
  nestC = (await jsonRequest(app, "POST", "/nests", { name: "Gamma" }, owner.apiKey)).data.nest.id;
  for (const n of [nestA, nestB]) {
    const r = await jsonRequest(app, "POST", `/nests/${n}/collaborators`, { email: creator.email, permission: "admin" }, owner.apiKey);
    expect(r.status).toBe(201);
  }
  await jsonRequest(app, "POST", `/nests/${nestA}/collaborators`, { email: editor.email, permission: "write" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestC}/nodes`, { title: "Gamma Doc", content: "gamma" }, owner.apiKey);

  // Governed nest A: owner reviews.
  await jsonRequest(app, "PATCH", `/nests/${nestA}/settings`, { stewardship_enabled: true }, owner.apiKey);
  const nestPath = join(env.dataDir, "nests", nestA);
  mkdirSync(nestPath, { recursive: true });
  writeFileSync(
    join(nestPath, "stewards.yaml"),
    `version: 1\nnest:\n  - email: ${owner.email}, role: reviewer, can_approve: true\n`,
  );
  await jsonRequest(app, "POST", `/nests/${nestA}/stewards/sync`, {}, owner.apiKey);
  humansBefore = (await jsonRequest(app, "GET", "/stats", undefined, serverAdmin.apiKey)).data.users;
});

afterAll(() => env.cleanup());

describe("GWT 8 — create", () => {
  it("an editor (not admin) cannot create a system", async () => {
    const r = await jsonRequest(app, "POST", "/systems", { name: "Nope", capability: "write", nest_ids: [nestA] }, editor.apiKey);
    expect(r.status).toBe(403);
  });

  it("an admin can't grant a nest they don't administer", async () => {
    const r = await jsonRequest(app, "POST", "/systems", { name: "Nope", capability: "write", nest_ids: [nestA, nestC] }, creator.apiKey);
    expect([403, 404]).toContain(r.status);
  });

  it("validates name and capability", async () => {
    const r1 = await jsonRequest(app, "POST", "/systems", { capability: "write", nest_ids: [nestA] }, creator.apiKey);
    expect(r1.status).toBe(400);
    const r2 = await jsonRequest(app, "POST", "/systems", { name: "X", capability: "admin", nest_ids: [nestA] }, creator.apiKey);
    expect(r2.status).toBe(400);
    const r3 = await jsonRequest(app, "POST", "/systems", { name: "X", capability: "write", nest_ids: [] }, creator.apiKey);
    expect(r3.status).toBe(400);
  });

  it("an admin creates 'GitHub sync' with write on A+B; key shown once", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      "/systems",
      { name: "GitHub sync", capability: "write", nest_ids: [nestA, nestB] },
      creator.apiKey,
    );
    expect(r.status).toBe(201);
    expect(r.data.api_key).toMatch(/^cnst_sys_[0-9a-f]{64}$/);
    expect(r.data.name).toBe("GitHub sync");
    expect(r.data.capability).toBe("write");
    expect(r.data.nests.map((n: any) => n.id).sort()).toEqual([nestA, nestB].sort());
    systemId = r.data.id;
    systemKey = r.data.api_key;
    systemEmail = r.data.email;
    expect(systemEmail).toBeTruthy();

    const list = await jsonRequest(app, "GET", "/systems", undefined, creator.apiKey);
    expect(JSON.stringify(list.data)).not.toContain(systemKey);
  });

  it("the system appears in the nest roster marked as a system", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestA}/collaborators`, undefined, owner.apiKey);
    const row = r.data.collaborators.find((c: any) => c.user_id === systemId);
    expect(row).toBeTruthy();
    expect(row.permission).toBe("write");
    expect(row.principal_kind).toBe("system");
  });
});

describe("a system is a service identity, but not a headless reader", () => {
  it("reaches routes the headless allowlist closes (version history, writes)", async () => {
    const created = await jsonRequest(app, "POST", `/nests/${nestB}/nodes`, { title: "Sys Probe", content: "probe" }, systemKey);
    expect(created.status).toBe(201);
    const v = await jsonRequest(app, "GET", `/nests/${nestB}/nodes/${created.data.node.id}/versions`, undefined, systemKey);
    expect(v.status).toBe(200);
    expect(JSON.stringify(v.data)).not.toContain("headless_reader");
  });

  it("MCP advertises the editor tool set, not the headless reader set", async () => {
    const t = await mcp(`/nests/${nestB}/mcp`, "tools/list", {}, systemKey);
    const names = t.body.result.tools.map((x: any) => x.name);
    expect(names).toContain("context_create");
    expect(names).toContain("context_versions");
    // Admin tools are for people only.
    expect(names).not.toContain("context_systems");
    expect(names).not.toContain("context_headless");
  });
});

describe("GWT 9 — writes are attributed to the system; governance intact", () => {
  let nodeId: string;
  it("system creates a doc in a governed nest → draft authored by the system", async () => {
    const r = await jsonRequest(app, "POST", `/nests/${nestA}/nodes`, { title: "Synced Readme", content: "from github" }, systemKey);
    expect(r.status).toBe(201);
    nodeId = r.data.node.id;
    const v = await jsonRequest(app, "GET", `/nests/${nestA}/nodes/${nodeId}/versions`, undefined, owner.apiKey);
    expect(v.status).toBe(200);
    const versions = v.data.versions ?? v.data;
    const authors = JSON.stringify(versions);
    expect(authors).toContain(systemEmail);
    expect(authors).not.toContain(creator.email);
    // Not published: the public view would not see it, and it's a draft.
    const latest = Array.isArray(versions) ? versions[0] : null;
    if (latest?.status) expect(latest.status).not.toBe("published");
  });

  it("system submits for review; owner approves → approved", async () => {
    const s = await jsonRequest(app, "POST", `/nests/${nestA}/nodes/${nodeId}/submit-review`, { note: "sync" }, systemKey);
    expect([200, 201]).toContain(s.status);
    // The system can't approve its own work.
    const selfApprove = await jsonRequest(app, "POST", `/nests/${nestA}/nodes/${nodeId}/approve`, {}, systemKey);
    expect(selfApprove.status).toBe(403);
    const a = await jsonRequest(app, "POST", `/nests/${nestA}/nodes/${nodeId}/approve`, {}, owner.apiKey);
    expect(a.status).toBe(200);
  });
});

describe("GWT 10 — ungranted nests", () => {
  it("REST on an ungranted nest → 403/404", async () => {
    for (const [m, p, b] of [
      ["GET", `/nests/${nestC}/nodes`],
      ["POST", `/nests/${nestC}/nodes`, { title: "x", content: "y" }],
      ["GET", `/nests/${nestC}`],
    ] as Array<[string, string, any]>) {
      const r = await jsonRequest(app, m, p, b, systemKey);
      expect([403, 404], `${m} ${p}`).toContain(r.status);
    }
  });

  it("MCP on an ungranted nest → 403/404", async () => {
    const r = await mcp(`/nests/${nestC}/mcp`, "tools/list", {}, systemKey);
    expect([403, 404]).toContain(r.httpStatus);
  });

  it("GET /nests lists only granted nests", async () => {
    const r = await jsonRequest(app, "GET", "/nests", undefined, systemKey);
    expect(r.status).toBe(200);
    const ids = r.data.nests.map((n: any) => n.id);
    expect(ids).toContain(nestA);
    expect(ids).not.toContain(nestC);
  });

  it("a system can't touch admin surfaces of its own nests", async () => {
    for (const [m, p, b] of [
      ["GET", `/nests/${nestA}/collaborators`],
      ["POST", `/nests/${nestA}/collaborators`, { email: "x@sys.test", permission: "read" }],
      ["PATCH", `/nests/${nestA}/visibility`, { visibility: "public" }],
      ["GET", `/nests/${nestA}/headless`],
      ["PUT", `/nests/${nestA}/headless`, { enabled: true }],
      ["POST", `/nests/${nestA}/headless/keys`, { label: "x" }],
      ["GET", `/nests/${nestA}/systems`],
      ["POST", "/nests", { name: "sys nest" }],
    ] as Array<[string, string, any]>) {
      const r = await jsonRequest(app, m, p, b, systemKey);
      expect([403, 404], `${m} ${p} → ${r.status}`).toContain(r.status);
    }
  });

  it("server-level MCP nest_create is refused for a system", async () => {
    const r = await mcp("/mcp", "tools/call", { name: "nest_create", arguments: { name: "sysnest" } }, systemKey);
    expect(resultText(r.body) + JSON.stringify(r.body)).toMatch(/system|cannot|refus/i);
    const all = await jsonRequest(app, "GET", "/nests", undefined, owner.apiKey);
    expect(all.data.nests.some((n: any) => n.name === "sysnest")).toBe(false);
  });
});

describe("GWT 11 — no login, sessions, or key minting as the system", () => {
  it("password login as the system is refused", async () => {
    for (const password of ["", "!", "testpass", "x"]) {
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: systemEmail, password: password || "anything" }),
      });
      expect([400, 401, 403]).toContain(res.status);
      expect(res.headers.get("set-cookie") || "").not.toContain("cnst_session=");
    }
  });

  it("createSession refuses a system principal", async () => {
    const sessions = await import("../src/auth/sessions.js");
    await expect(sessions.createSession(systemId)).rejects.toThrow();
  });

  it("minting / rotating / listing keys AS the system is refused", async () => {
    for (const [m, p, b] of [
      ["POST", "/auth/keys", { label: "escape" }],
      ["GET", "/auth/keys"],
      ["POST", "/auth/keys/rotate", {}],
      ["POST", "/auth/password", { current: "x", next: "yyyyyyyyyyyy" }],
      ["POST", "/systems", { name: "child", capability: "write", nest_ids: [nestA] }],
    ] as Array<[string, string, any]>) {
      const r = await jsonRequest(app, m, p, b, systemKey);
      expect([401, 403], `${m} ${p} → ${r.status}`).toContain(r.status);
    }
  });

  it("an admin can't reset the system's password", async () => {
    const r = await jsonRequest(app, "POST", `/auth/admin/reset-password/${systemId}`, {}, serverAdmin.apiKey);
    expect([400, 403]).toContain(r.status);
  });

  it("a system can't be added to another nest through the plain collaborator invite", async () => {
    const r = await jsonRequest(app, "POST", `/nests/${nestC}/collaborators`, { email: systemEmail, permission: "write" }, owner.apiKey);
    expect([400, 403]).toContain(r.status);
  });

  it("a system collaborator can't be promoted to nest admin", async () => {
    const collabs = await jsonRequest(app, "GET", `/nests/${nestB}/collaborators`, undefined, owner.apiKey);
    const row = collabs.data.collaborators.find((c: any) => c.user_id === systemId);
    const r = await jsonRequest(app, "PATCH", `/nests/${nestB}/collaborators/${row.id}`, { permission: "admin" }, owner.apiKey);
    expect([400, 403]).toContain(r.status);
  });
});

describe("GWT 14 — systems are not seats", () => {
  it("excluded from /auth/teammates and the /stats user count", async () => {
    const t = await jsonRequest(app, "GET", "/auth/teammates", undefined, serverAdmin.apiKey);
    expect(t.status).toBe(200);
    expect(t.data.teammates.some((u: any) => u.id === systemId)).toBe(false);
    const s = await jsonRequest(app, "GET", "/stats", undefined, serverAdmin.apiKey);
    expect(s.status).toBe(200);
    // The system (and a headless access key's identity) doesn't add to the count.
    expect((await jsonRequest(app, "PUT", `/nests/${nestB}/headless`, { enabled: true }, owner.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "POST", `/nests/${nestB}/headless/keys`, { label: "seat probe" }, owner.apiKey)).status).toBe(201);
    await jsonRequest(app, "PUT", `/nests/${nestB}/headless`, { enabled: false }, owner.apiKey);
    const s2 = await jsonRequest(app, "GET", "/stats", undefined, serverAdmin.apiKey);
    expect(s.data.users).toBe(humansBefore);
    expect(s2.data.users).toBe(humansBefore);
  });
});

describe("GWT 13 — list, rotate, add/remove nests, revoke", () => {
  it("any admin of a granted nest lists it with metadata", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestA}/systems`, undefined, owner.apiKey);
    expect(r.status).toBe(200);
    const s = r.data.systems.find((x: any) => x.id === systemId);
    expect(s).toMatchObject({ name: "GitHub sync", capability: "write", created_by: creator.userId });
    expect(s.nests.map((n: any) => n.id).sort()).toEqual([nestA, nestB].sort());
    expect(s.last_used_at).toBeTruthy();
    const all = await jsonRequest(app, "GET", "/systems", undefined, owner.apiKey);
    expect(all.data.systems.some((x: any) => x.id === systemId)).toBe(true);
  });

  it("an outsider sees nothing and can't touch it", async () => {
    const all = await jsonRequest(app, "GET", "/systems", undefined, outsider.apiKey);
    expect(all.status).toBe(200);
    expect(all.data.systems.some((x: any) => x.id === systemId)).toBe(false);
    for (const [m, p, b] of [
      ["POST", `/systems/${systemId}/rotate`, {}],
      ["DELETE", `/systems/${systemId}`],
      ["POST", `/systems/${systemId}/nests`, { nest_id: nestC }],
    ] as Array<[string, string, any]>) {
      const r = await jsonRequest(app, m, p, b, outsider.apiKey);
      expect([403, 404], `${m} ${p}`).toContain(r.status);
    }
  });

  it("add a nest the admin administers; remove one", async () => {
    const add = await jsonRequest(app, "POST", `/systems/${systemId}/nests`, { nest_id: nestC }, owner.apiKey);
    expect(add.status).toBe(200);
    const read = await jsonRequest(app, "GET", `/nests/${nestC}/nodes`, undefined, systemKey);
    expect(read.status).toBe(200);
    const rm = await jsonRequest(app, "DELETE", `/systems/${systemId}/nests/${nestC}`, undefined, owner.apiKey);
    expect(rm.status).toBe(200);
    const after = await jsonRequest(app, "GET", `/nests/${nestC}/nodes`, undefined, systemKey);
    expect([403, 404]).toContain(after.status);
  });

  it("rotate: old key fails immediately, new key works", async () => {
    const r = await jsonRequest(app, "POST", `/systems/${systemId}/rotate`, {}, owner.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.api_key).toMatch(/^cnst_sys_/);
    const old = await jsonRequest(app, "GET", `/nests/${nestA}/nodes`, undefined, systemKey);
    expect(old.status).toBe(401);
    systemKey = r.data.api_key;
    const fresh = await jsonRequest(app, "GET", `/nests/${nestA}/nodes`, undefined, systemKey);
    expect(fresh.status).toBe(200);
  });
});

describe("GWT 12 — owned by the nests, not the creator", () => {
  it("creator removed from the nests AND deleted from the server → key still works", async () => {
    for (const n of [nestA, nestB]) {
      const collabs = await jsonRequest(app, "GET", `/nests/${n}/collaborators`, undefined, owner.apiKey);
      const row = collabs.data.collaborators.find((c: any) => c.user_id === creator.userId);
      const del = await jsonRequest(app, "DELETE", `/nests/${n}/collaborators/${row.id}`, undefined, owner.apiKey);
      expect(del.status).toBe(200);
    }
    const gone = await jsonRequest(app, "DELETE", `/auth/users/${creator.userId}`, undefined, serverAdmin.apiKey);
    expect(gone.status).toBe(200);

    const r = await jsonRequest(app, "GET", `/nests/${nestA}/nodes`, undefined, systemKey);
    expect(r.status).toBe(200);
    const w = await jsonRequest(app, "POST", `/nests/${nestB}/nodes`, { title: "After Creator", content: "still syncing" }, systemKey);
    expect(w.status).toBe(201);
    // Still listed (creator metadata preserved as recorded).
    const list = await jsonRequest(app, "GET", `/nests/${nestA}/systems`, undefined, owner.apiKey);
    const s = list.data.systems.find((x: any) => x.id === systemId);
    expect(s.created_by_email).toBe(creator.email);
  });
});

describe("read-capability systems", () => {
  it("a read system can read but not write", async () => {
    const r = await jsonRequest(app, "POST", "/systems", { name: "Indexer", capability: "read", nest_ids: [nestB] }, owner.apiKey);
    expect(r.status).toBe(201);
    const k = r.data.api_key;
    expect((await jsonRequest(app, "GET", `/nests/${nestB}/nodes`, undefined, k)).status).toBe(200);
    expect((await jsonRequest(app, "POST", `/nests/${nestB}/nodes`, { title: "x", content: "y" }, k)).status).toBe(403);
    const tools = await mcp(`/nests/${nestB}/mcp`, "tools/list", {}, k);
    const names = tools.body.result.tools.map((t: any) => t.name);
    expect(names).toContain("context_get");
    expect(names).not.toContain("context_create");
  });
});

describe("GWT 13 — revoke", () => {
  it("an admin of every granted nest revokes it; key fails immediately", async () => {
    const r = await jsonRequest(app, "DELETE", `/systems/${systemId}`, undefined, owner.apiKey);
    expect(r.status).toBe(200);
    const after = await jsonRequest(app, "GET", `/nests/${nestA}/nodes`, undefined, systemKey);
    expect(after.status).toBe(401);
    const list = await jsonRequest(app, "GET", `/nests/${nestA}/systems`, undefined, owner.apiKey);
    expect(list.data.systems.some((x: any) => x.id === systemId)).toBe(false);
  });
});

describe("GWT 15 — MCP admin tools at REST parity", () => {
  let mcpSystemId: string;

  it("tools are advertised to nest admins only", async () => {
    const asOwner = await mcp(`/nests/${nestB}/mcp`, "tools/list", {}, owner.apiKey);
    const names = asOwner.body.result.tools.map((t: any) => t.name);
    expect(names).toContain("context_headless");
    expect(names).toContain("context_systems");
    const asEditor = await mcp(`/nests/${nestA}/mcp`, "tools/list", {}, editor.apiKey);
    const enames = asEditor.body.result.tools.map((t: any) => t.name);
    expect(enames).not.toContain("context_headless");
    expect(enames).not.toContain("context_systems");
  });

  it("a non-admin calling the tools directly is refused", async () => {
    const r = await callTool(nestA, "context_headless", { action: "enable" }, editor.apiKey);
    expect(JSON.stringify(r.body)).toMatch(/admin|not found|denied|permission/i);
    const st = await jsonRequest(app, "GET", `/nests/${nestA}/headless`, undefined, owner.apiKey);
    expect(st.data.enabled).toBe(false);
    const s2 = await callTool(nestA, "context_systems", { action: "create", name: "Sneaky", capability: "write" }, editor.apiKey);
    expect(JSON.stringify(s2.body)).toMatch(/not found|admin|denied|permission/i);
    expect(JSON.stringify(s2.body)).not.toContain("cnst_sys_");
    // The service layer re-checks even when the tool is dispatched directly.
    const { handleToolCall } = await import("../src/mcp/tools.js");
    const out = (await handleToolCall("context_systems", { action: "create", name: "Sneaky", capability: "write" }, {
      nestId: nestA, userId: editor.userId, userEmail: editor.email, capability: "write",
    } as any)) as { text: string };
    expect(out.text).toMatch(/owner or admin/i);
    expect(out.text).not.toContain("cnst_sys_");
  });

  it("systems: create → list → add/remove nest → rotate → revoke", async () => {
    const c = await callTool(nestB, "context_systems", { action: "create", name: "MCP Bot", capability: "write" }, owner.apiKey);
    const created = c.body.result.structuredContent;
    expect(created.api_key).toMatch(/^cnst_sys_/);
    expect(created.nests.map((n: any) => n.id)).toEqual([nestB]);
    mcpSystemId = created.id;

    const l = await callTool(nestB, "context_systems", { action: "list" }, owner.apiKey);
    expect(resultText(l.body)).toContain("MCP Bot");
    expect(resultText(l.body)).not.toContain(created.api_key);

    const add = await callTool(nestB, "context_systems", { action: "add_nest", system_id: mcpSystemId, nest_id: nestC }, owner.apiKey);
    expect(resultText(add.body)).not.toMatch(/error|denied/i);
    expect((await jsonRequest(app, "GET", `/nests/${nestC}/nodes`, undefined, created.api_key)).status).toBe(200);
    await callTool(nestB, "context_systems", { action: "remove_nest", system_id: mcpSystemId, nest_id: nestC }, owner.apiKey);
    expect([403, 404]).toContain((await jsonRequest(app, "GET", `/nests/${nestC}/nodes`, undefined, created.api_key)).status);

    const r = await callTool(nestB, "context_systems", { action: "rotate", system_id: mcpSystemId }, owner.apiKey);
    const rotated = r.body.result.structuredContent;
    expect((await jsonRequest(app, "GET", `/nests/${nestB}/nodes`, undefined, created.api_key)).status).toBe(401);
    expect((await jsonRequest(app, "GET", `/nests/${nestB}/nodes`, undefined, rotated.api_key)).status).toBe(200);

    const d = await callTool(nestB, "context_systems", { action: "revoke", system_id: mcpSystemId }, owner.apiKey);
    expect(resultText(d.body)).toMatch(/revoked/i);
    expect((await jsonRequest(app, "GET", `/nests/${nestB}/nodes`, undefined, rotated.api_key)).status).toBe(401);
  });

  it("a read-only key of an admin does not see or run the admin tools", async () => {
    const ro = (await jsonRequest(app, "POST", "/auth/keys", { label: "ro-b", nest_id: nestB, capability: "read" }, owner.apiKey)).data.api_key;
    const t = await mcp(`/nests/${nestB}/mcp`, "tools/list", {}, ro);
    const names = t.body.result.tools.map((x: any) => x.name);
    expect(names).not.toContain("context_systems");
    expect(names).not.toContain("context_headless");
    const r = await callTool(nestB, "context_systems", { action: "create", name: "Escape", capability: "write" }, ro);
    expect(JSON.stringify(r.body)).not.toContain("cnst_sys_");
  });
});
