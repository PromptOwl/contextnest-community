/**
 * MCP `context_search` ↔ REST `GET /nests/:id/search` parity.
 *
 * `ctx search --vault <remote>` calls the per-nest MCP `context_search` tool.
 * On a 444-node governed nest it hit the CLI's 30s REMOTE_TIMEOUT while the
 * REST search on the same nest answered instantly: the tool resolved the
 * approved, access-gated body of EVERY document in the nest (per-node
 * permission lookups + a version-chain reconstruction each) before matching a
 * single term, where REST matches against the cached discovery set first and
 * gates only the hits. These pin the tool to the REST path: same hits, same
 * order, same access filtering, and a time budget a CLI can live with.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let owner: User;
let outsider: User; // public reader: approved documents only

const NODE_COUNT = 180;
const QUERY = "widget";

async function mcpSearch(
  apiKey: string,
  args: Record<string, unknown>,
): Promise<{ text: string; data: any; ms: number }> {
  const started = Date.now();
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "context_search", arguments: args },
    }),
  });
  const ms = Date.now() - started;
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  let body: any;
  if (ct.includes("application/json")) body = await res.json();
  else {
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    body = dataLine ? JSON.parse(dataLine.slice("data: ".length)) : text;
  }
  expect(body.error).toBeUndefined();
  return {
    text: body.result.content.map((c: any) => c.text).join(""),
    data: body.result.structuredContent,
    ms,
  };
}

async function restSearch(apiKey: string, q = QUERY) {
  const { status, data } = await jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/search?q=${encodeURIComponent(q)}`,
    undefined,
    apiKey,
  );
  expect(status).toBe(200);
  return data as { query: string; count: number; nodes: any[] };
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  outsider = await registerUser(app, "outsider@example.com", "Outsider");

  const nest = await jsonRequest(
    app,
    "POST",
    "/nests",
    { name: "Search Parity" },
    owner.apiKey,
  );
  nestId = nest.data.nest.id;

  // Governed + self-approve, so every seeded document lands approved and the
  // stewardship branch (approved-version lookup + reconstruction) is the one
  // exercised — that is the branch that timed out in the field.
  const settings = await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true, allow_self_approve: true },
    owner.apiKey,
  );
  expect(settings.status).toBe(200);
  expect(settings.data.stewardship_enabled).toBe(true);

  // Public, so an unrelated account is a public reader (approved-only).
  const vis = await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/visibility`,
    { visibility: "public", acknowledge_public: true },
    owner.apiKey,
  );
  expect(vis.status).toBe(200);

  // ~1/3 of the nest mentions the query, some in the title (which REST ranks
  // first), most only in the body — well over the default page of 20.
  for (let i = 0; i < NODE_COUNT; i++) {
    const inTitle = i % 30 === 0;
    const inBody = i % 3 === 0;
    const title = inTitle ? `Widget Guide ${i}` : `Doc ${i}`;
    const body = inBody
      ? `# ${title}\n\nNotes on the widget rollout, part ${i}.`
      : `# ${title}\n\nUnrelated notes, part ${i}.`;
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title, content: body, tags: inBody ? ["rollout"] : ["misc"] },
      owner.apiKey,
    );
    expect(res.status, `seed ${i}: ${JSON.stringify(res.data)}`).toBe(201);
  }

  // Drafts: self-approve off, then two more matching documents that stay
  // unapproved. A member sees them in search (REST does), a public reader
  // must not.
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { allow_self_approve: false },
    owner.apiKey,
  );
  for (const title of ["Widget Draft A", "Widget Draft B"]) {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title, content: `# ${title}\n\nunreviewed widget notes` },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
  }
}, 120_000);

afterAll(() => env.cleanup());

describe("context_search parity with GET /search", () => {
  it("returns the same hits, in the same order, as REST — and fast", async () => {
    const rest = await restSearch(owner.apiKey);
    expect(rest.count).toBeGreaterThan(20);

    const mcp = await mcpSearch(owner.apiKey, { query: QUERY });
    const ids = mcp.data.results.map((r: any) => r.id);
    // Default page is 20; `count` reports everything found, like REST.
    expect(mcp.data.count).toBe(rest.count);
    expect(ids).toEqual(rest.nodes.slice(0, 20).map((n: any) => n.id));
    expect(mcp.text).toContain(`Found ${rest.count} node(s)`);
    // Same speed class as REST: on a 300-node governed nest this used to cost a
    // per-node version reconstruction before any matching happened.
    expect(mcp.ms, `context_search took ${mcp.ms}ms`).toBeLessThan(2000);
  });

  it("honours `limit` while still reporting the full count", async () => {
    const rest = await restSearch(owner.apiKey);
    const mcp = await mcpSearch(owner.apiKey, { query: QUERY, limit: 5 });
    expect(mcp.data.results).toHaveLength(5);
    expect(mcp.data.count).toBe(rest.count);
    expect(mcp.data.results.map((r: any) => r.id)).toEqual(
      rest.nodes.slice(0, 5).map((n: any) => n.id),
    );
  });

  it("ranks a title hit above body-only hits, like REST", async () => {
    const mcp = await mcpSearch(owner.apiKey, { query: QUERY, limit: 3 });
    for (const r of mcp.data.results) {
      expect(r.title.toLowerCase()).toContain(QUERY);
    }
  });

  it("returns gated bodies, never the unapproved draft", async () => {
    const mcp = await mcpSearch(owner.apiKey, { query: "unreviewed" });
    // Owner is a member: REST lists the drafts, so the tool lists them too —
    // but their body is withheld until approved.
    const rest = await restSearch(owner.apiKey, "unreviewed");
    expect(rest.count).toBe(2);
    expect(mcp.data.count).toBe(2);
    for (const r of mcp.data.results) expect(r.body).toBeUndefined();
    expect(mcp.text).not.toContain("unreviewed widget notes");
  });

  it("a public reader sees approved hits only — same set as REST", async () => {
    const rest = await restSearch(outsider.apiKey);
    const ownerRest = await restSearch(owner.apiKey);
    expect(rest.count).toBe(ownerRest.count - 2);
    expect(rest.nodes.some((n: any) => /Widget Draft/.test(n.title))).toBe(false);

    const mcp = await mcpSearch(outsider.apiKey, { query: QUERY, limit: 500 });
    expect(mcp.data.count).toBe(rest.count);
    expect(mcp.data.results.map((r: any) => r.id)).toEqual(
      rest.nodes.map((n: any) => n.id),
    );
    expect(mcp.text).not.toContain("Widget Draft");
  });

  it("says so when nothing matches", async () => {
    const mcp = await mcpSearch(owner.apiKey, { query: "zzz-no-such-term" });
    expect(mcp.data.results).toEqual([]);
    expect(mcp.data.count).toBe(0);
    expect(mcp.text).toMatch(/No nodes matched/);
  });
});

describe("GET /search is unchanged (regression)", () => {
  it("keeps its wire shape", async () => {
    const rest = await restSearch(owner.apiKey);
    expect(rest.query).toBe(QUERY);
    expect(Object.keys(rest).sort()).toEqual(["count", "nodes", "query"]);
    expect(rest.count).toBe(rest.nodes.length);
    for (const n of rest.nodes) {
      expect(Object.keys(n).sort()).toEqual(["id", "snippet", "tags", "title", "type"]);
    }
  });
});
