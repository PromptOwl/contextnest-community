/**
 * po-1213 — one documents home. The list reads the nest page and agents use
 * carry who last edited each document, the human first and the agent second,
 * so the Documents rows, the "Recently edited" feed and an agent's
 * context_list all name the same two writers.
 *
 *   AC-NH-07  REST list, census `recent` and MCP context_list carry
 *             `last_edit` (time, human, agent).
 *   AC-NH-08  A public reader and a headless key get no editor identity — the
 *             same rule as `collaborators` and the node detail's `last_edit`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
  resetAuthRateLimit,
} from "./helpers";
import { getDb } from "../src/db/client.js";

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let stranger: User;
let nestId: string;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function callTool(apiKey: string, name: string, args: Record<string, unknown> = {}) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(apiKey) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  return body.result;
}

const listRows = async (apiKey: string) =>
  (await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, apiKey)).data.nodes as any[];
const rowFor = (rows: any[], title: string) => rows.find((r) => r.title === title);

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { ownerEmail: "owner@home.test" });
  owner = await registerUser(app, "owner@home.test", "Owner");
  await resetAuthRateLimit();
  stranger = await registerUser(app, "stranger@home.test", "Stranger");

  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Home" }, owner.apiKey)).data.nest.id;

  // An agent write: the key's owner is the human, the agent rides in `client`.
  const agentDoc = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Agent Doc", content: "v1", client: { agent: "mkt-amplifier", session_id: "s-1" } },
    owner.apiKey,
  );
  // Edited a second time by another agent: the LATEST version names it.
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/nodes/${agentDoc.data.node.id}`,
    { content: "v2", client: { agent: "deal-desk" } },
    owner.apiKey,
  );
  // A hand edit: no agent at all.
  process.env.CONTEXTNEST_NO_ATTRIBUTION = "1";
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Hand Doc", content: "body" }, owner.apiKey);
  delete process.env.CONTEXTNEST_NO_ATTRIBUTION;
  // Enough documents for the feed to need its cap.
  for (let i = 1; i <= 5; i++) {
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: `Filler ${i}`, content: "x" }, owner.apiKey);
  }
});

afterAll(() => env.cleanup());

describe("AC-NH-07: the REST list names each document's last editor", () => {
  it("Given an agent wrote the latest version, then the row carries the human and that agent", async () => {
    const row = rowFor(await listRows(owner.apiKey), "Agent Doc");
    expect(row.last_edit).toMatchObject({
      version: 2,
      edited_by: "owner@home.test",
      client: { agent: "deal-desk" },
    });
    expect(Number.isNaN(Date.parse(row.last_edit.edited_at))).toBe(false);
  });

  it("Given a hand edit, then the row names the human and no client", async () => {
    const row = rowFor(await listRows(owner.apiKey), "Hand Doc");
    expect(row.last_edit.edited_by).toBe("owner@home.test");
    expect(row.last_edit.client).toBeUndefined();
  });
});

describe("AC-NH-02/07: the census feed carries the editor", () => {
  it("Given a nest, then census.recent lists up to 5 documents, newest first, each with last_edit", async () => {
    const { status, data } = await jsonRequest(app, "GET", `/nests/${nestId}/census`, undefined, owner.apiKey);
    expect(status).toBe(200);
    const recent = data.census.recent as any[];
    expect(recent).toHaveLength(5);
    const times = recent.map((r) => String(r.updated_at));
    expect([...times].sort().reverse()).toEqual(times);
    for (const r of recent) {
      expect(r.last_edit?.edited_by).toBe("owner@home.test");
    }
  });
});

describe("review: the editor is a real edit, and the feed's time agrees with its order", () => {
  it("Given an auto-publish bump row is the newest version, then last_edit still names the last real edit", async () => {
    const rows = await listRows(owner.apiKey);
    const row = rowFor(rows, "Agent Doc");
    // A legacy bump row on top: not an edit (SYSTEM_AUTHOR_PREFIX).
    await getDb().run(
      `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [nestId, row.id, 99, "bump", "system:auto-publish:owner@home.test", "published"],
    );
    const after = rowFor(await listRows(owner.apiKey), "Agent Doc");
    expect(after.last_edit).toMatchObject({ version: 2, edited_by: "owner@home.test", client: { agent: "deal-desk" } });
    const detail = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${row.id}`, undefined, owner.apiKey);
    expect(detail.data.node.last_edit.edited_by).toBe("owner@home.test");
    await getDb().run(`DELETE FROM node_versions WHERE nest_id = ? AND node_id = ? AND version = 99`, [nestId, row.id]);
  });

  it("Given a document whose only version rows are auto-publish bumps, then it has no last_edit", async () => {
    await getDb().run(
      `INSERT INTO node_versions (nest_id, node_id, version, content_hash, author, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [nestId, "nodes/bump-only", 1, "bump", "system:auto-publish:owner@home.test", "published"],
    );
    const { getLatestVersionAttributions } = await import("../src/governance/version-service.js");
    const map = await getLatestVersionAttributions(nestId, ["nodes/bump-only"]);
    expect(map.has("nodes/bump-only")).toBe(false);
    await getDb().run(`DELETE FROM node_versions WHERE nest_id = ? AND node_id = ?`, [nestId, "nodes/bump-only"]);
  });

  it("Given more than 500 ids, then every chunk is read and a real id past the boundary is found", async () => {
    const { getLatestVersionAttributions } = await import("../src/governance/version-service.js");
    const real = rowFor(await listRows(owner.apiKey), "Hand Doc").id;
    const ids = [...Array.from({ length: 600 }, (_, i) => `nodes/missing-${i}`), real];
    const map = await getLatestVersionAttributions(nestId, ids);
    expect(map.size).toBe(1);
    expect(map.get(real)?.editedBy).toBe("owner@home.test");
    expect((await getLatestVersionAttributions(nestId, [])).size).toBe(0);
  });

  it("Given the census feed, then each item's version time is the same write as the updated_at it is sorted on", async () => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/census`, undefined, owner.apiKey);
    for (const r of data.census.recent as any[]) {
      const gap = Math.abs(Date.parse(r.updated_at) - Date.parse(String(r.last_edit.edited_at).replace(" ", "T").replace(/(\d)$/, "$1Z")));
      expect(gap).toBeLessThan(60_000);
    }
  });
});

describe("AC-NH-07: MCP context_list has parity with the REST list", () => {
  it("Given an agent's latest write, then the prose names the human, then the agent, with the date", async () => {
    const res = await callTool(owner.apiKey, "context_list", {});
    expect(res.isError).toBeFalsy();
    // Prose only: the engine catalog has no provenance field yet, so the
    // structured documents[] stays catalog-shaped.
    const doc = res.structuredContent.documents.find((d: any) => d.title === "Agent Doc");
    expect(doc.last_edit).toBeUndefined();
    expect(res.content[0].text).toMatch(/\*\*Agent Doc\*\*[^\n]* · edited by owner@home\.test via deal-desk, \d{4}-\d{2}-\d{2}/);
  });

  it("Given a hand edit, then the prose names only the human", async () => {
    const res = await callTool(owner.apiKey, "context_list", {});
    const line = (res.content[0].text as string).split("\n").find((l) => l.includes("**Hand Doc**"))!;
    expect(line).toContain("edited by owner@home.test");
    expect(line).not.toContain(" via ");
  });
});

describe("AC-NH-08: no editor identity for public readers or headless keys", () => {
  beforeAll(async () => {
    const vis = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public", acknowledge_public: true },
      owner.apiKey,
    );
    expect(vis.status).toBeLessThan(300);
  });

  it("Given a public reader, then list rows and the census feed carry no last_edit", async () => {
    const rows = await listRows(stranger.apiKey);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.last_edit).toBeUndefined();
    const census = await jsonRequest(app, "GET", `/nests/${nestId}/census`, undefined, stranger.apiKey);
    for (const r of census.data.census?.recent ?? []) expect(r.last_edit).toBeUndefined();
  });

  it("Given a public reader on MCP, then context_list names no editor", async () => {
    const res = await callTool(stranger.apiKey, "context_list", {});
    expect(res.isError).toBeFalsy();
    for (const d of res.structuredContent.documents) expect(d.last_edit).toBeUndefined();
    expect(res.content[0].text).not.toContain("edited by");
  });

  it("Given a headless access key, then the list and context_list name no editor", async () => {
    await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "private" }, owner.apiKey);
    const on = await jsonRequest(app, "PUT", `/nests/${nestId}/headless`, { enabled: true }, owner.apiKey);
    expect(on.status).toBeLessThan(300);
    const minted = await jsonRequest(app, "POST", `/nests/${nestId}/headless/keys`, { label: "Acme" }, owner.apiKey);
    expect(minted.status).toBe(201);
    const key = minted.data.api_key as string;

    const rows = await listRows(key);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.last_edit).toBeUndefined();

    const res = await callTool(key, "context_list", {});
    expect(res.isError).toBeFalsy();
    for (const d of res.structuredContent.documents) expect(d.last_edit).toBeUndefined();
    expect(res.content[0].text).not.toContain("edited by");

    // The node detail follows the same rule.
    const detail = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${rows[0].id}`, undefined, key);
    expect(detail.status).toBe(200);
    expect(detail.data.node.last_edit).toBeUndefined();
  });
});
