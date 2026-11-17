/**
 * Context pull log — the Graph view's retrieval replay (po-1252).
 *
 * A "pull" is one retrieval call (MCP context_get / context_search /
 * context_query / context_resolve, REST search / query / context, Hootie):
 * the documents it handed over, in payload order, each with the version
 * served, its size, and — where the server ran the traversal — its hop depth
 * and the document it was reached from. It is a read model over the existing
 * access log (node_access_events); nothing else records it.
 *
 * GET /nests/:nestId/pulls            newest first (?limit, ?before, ?agent)
 * GET /nests/:nestId/pulls/:pullId    one pull
 * MCP context_pull_log                the same, for agents (pull_id → one)
 *
 * Who sees what: anyone who reads the nest sees pulls over the documents they
 * can read. The person and the agent behind a pull are shown only to callers
 * who can see editors (write and up — the same rule as the graph's steward
 * overlay). A public reader also gets no version numbers. Headless access keys
 * get neither the route nor the tool.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed } from "./helpers";
import { flushAccessLog, resetAccessThrottle, forgetAccessLogSetting } from "../src/governance/access-log.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
let rpcId = 1;

async function callTool(app: any, nestId: string, apiKey: string, name: string, args: Record<string, unknown>) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(apiKey) },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json")
    ? (await res.json()).result
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice("data: ".length),
      ).result;
}

async function pulls(app: any, nestId: string, key: string, query = "") {
  await flushAccessLog();
  return jsonRequest(app, "GET", `/nests/${nestId}/pulls${query}`, undefined, key);
}

describe("context pull log", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let editor: { apiKey: string };
  let viewer: { apiKey: string };
  let nestId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@fernhill.test", "Owner");
    editor = await registerUser(app, "editor@fernhill.test", "Editor");
    viewer = await registerUser(app, "viewer@fernhill.test", "Viewer");
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Pull Log" }, owner.apiKey)).data.nest.id;
    for (const [email, permission] of [
      ["editor@fernhill.test", "write"],
      ["viewer@fernhill.test", "read"],
    ]) {
      await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email, permission }, owner.apiKey);
    }
    // Returns → Warranty → Escalation is a chain; Brand stands alone.
    for (const [title, body] of [
      ["Returns Policy", "Returns within 45 days. Damaged items follow [[Warranty Terms]]."],
      ["Warranty Terms", "Lifetime warranty. Big claims go through [[Escalation Matrix]]."],
      ["Escalation Matrix", "Tier 2 handles warranty claims over 300 dollars."],
      ["Brand Voice", "Plain and warm; never promise more than the warranty covers."],
    ]) {
      const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: `# ${title}\n\n${body}` }, owner.apiKey);
      ids[title] = r.data.node.id;
    }
  });

  afterAll(() => env.cleanup());

  it("/health says the server ships the pull replay", async () => {
    const h = await (await app.request("/health")).json();
    expect(h.pull_replay).toBe(true);
  });

  it("records an MCP search as one pull: payload order, version and size per document, the tool and the agent", async () => {
    resetAccessThrottle();
    const res = await callTool(app, nestId, editor.apiKey, "context_search", {
      query: "warranty",
      client: { agent: "Support Copilot" },
    });
    expect(res.isError).toBeFalsy();
    const served = (res.structuredContent?.results ?? []).map((r: any) => r.id);
    expect(served.length).toBeGreaterThan(1);

    const { status, data } = await pulls(app, nestId, owner.apiKey);
    expect(status).toBe(200);
    expect(data.accessLogEnabled).toBe(true);
    const p = data.pulls[0];
    expect(p).toEqual(
      expect.objectContaining({
        tool: "context_search",
        surface: "mcp",
        actor: "editor@fernhill.test",
        agent: "Support Copilot",
        documents: served.length,
      }),
    );
    expect(typeof p.id).toBe("string");
    expect(p.steps.map((s: any) => s.nodeId)).toEqual(served);
    expect(p.steps.map((s: any) => s.seq)).toEqual(served.map((_: unknown, i: number) => i));
    for (const s of p.steps) {
      expect(s.version).toBe(1);
      expect(s.bytes).toBeGreaterThan(0);
      expect(s.hop).toBe(0);
      expect(s.via).toBeNull();
      expect(typeof s.title).toBe("string");
    }
    expect(p.bytes).toBe(p.steps.reduce((n: number, s: any) => n + s.bytes, 0));
  });

  it("records the traversal of a REST /context pull: hop depth and the document each was reached from", async () => {
    resetAccessThrottle();
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/context`, { selector: "[[Returns Policy]]", hops: 2 }, editor.apiKey);
    expect(r.status).toBe(200);
    const { data } = await pulls(app, nestId, owner.apiKey);
    const p = data.pulls[0];
    expect(p.tool).toBe("context");
    const byId = Object.fromEntries(p.steps.map((s: any) => [s.nodeId, s]));
    expect(byId[ids["Returns Policy"]]).toEqual(expect.objectContaining({ hop: 0, via: null }));
    expect(byId[ids["Warranty Terms"]]).toEqual(expect.objectContaining({ hop: 1, via: ids["Returns Policy"] }));
    expect(byId[ids["Escalation Matrix"]]).toEqual(expect.objectContaining({ hop: 2, via: ids["Warranty Terms"] }));
    expect(byId[ids["Brand Voice"]]).toBeUndefined();
    expect(p.maxHop).toBe(2);
    // The order is the compiled context's order — the order the steps were handed over.
    expect(p.steps.map((s: any) => s.nodeId)).toEqual(r.data.nodes.map((n: any) => n.id));
  });

  it("leaves hop unknown where the engine walked the graph (context_query, context_resolve), never \"matched\"", async () => {
    for (const [tool, args] of [
      ["context_query", { query: "type:document" }],
      ["context_resolve", { selector: "type:document", hops: 2 }],
    ] as const) {
      resetAccessThrottle();
      const res = await callTool(app, nestId, editor.apiKey, tool, { ...args, client: { agent: "Walker" } });
      expect(res.isError, `${tool}: ${JSON.stringify(res.content)}`).toBeFalsy();
      const p = (await pulls(app, nestId, owner.apiKey, "?limit=1")).data.pulls[0];
      expect(p.tool).toBe(tool);
      expect(p.steps.length).toBeGreaterThan(0);
      for (const s of p.steps) {
        expect(s.hop, tool).toBeNull();
        expect(s.via, tool).toBeNull();
      }
      expect(p.maxHop).toBeNull();
    }
  });

  it("reads one pull by id, and 404s an unknown one", async () => {
    const { data } = await pulls(app, nestId, owner.apiKey);
    const one = await jsonRequest(app, "GET", `/nests/${nestId}/pulls/${encodeURIComponent(data.pulls[0].id)}`, undefined, owner.apiKey);
    expect(one.status).toBe(200);
    expect(one.data.pull).toEqual(data.pulls[0]);
    const missing = await jsonRequest(app, "GET", `/nests/${nestId}/pulls/nope`, undefined, owner.apiKey);
    expect(missing.status).toBe(404);
  });

  it("records an identical repeated pull once, but a different pull over the same document in full", async () => {
    resetAccessThrottle();
    const before = (await pulls(app, nestId, owner.apiKey, "?limit=50")).data.pulls.length;
    await callTool(app, nestId, editor.apiKey, "context_get", { id: ids["Brand Voice"], client: { agent: "Loop Bot" } });
    await callTool(app, nestId, editor.apiKey, "context_get", { id: ids["Brand Voice"], client: { agent: "Loop Bot" } });
    const afterRepeat = (await pulls(app, nestId, owner.apiKey, "?limit=50")).data.pulls;
    expect(afterRepeat.length).toBe(before + 1);

    // A search that also returns Brand Voice is a new fact: recorded whole,
    // Brand Voice included, even inside the window.
    await callTool(app, nestId, editor.apiKey, "context_search", { query: "warm", client: { agent: "Loop Bot" } });
    const afterSearch = (await pulls(app, nestId, owner.apiKey, "?limit=50")).data.pulls;
    expect(afterSearch.length).toBe(before + 2);
    expect(afterSearch[0].steps.map((s: any) => s.nodeId)).toContain(ids["Brand Voice"]);
  });

  it("filters by agent, case-insensitively, and pages with a cursor", async () => {
    const { data } = await pulls(app, nestId, owner.apiKey, "?agent=loop%20bot");
    expect(data.pulls.length).toBe(2);
    expect(data.pulls.every((p: any) => p.agent === "Loop Bot")).toBe(true);

    const first = (await pulls(app, nestId, owner.apiKey, "?limit=1")).data;
    expect(first.pulls.length).toBe(1);
    expect(first.hasMore).toBe(true);
    const second = (await pulls(app, nestId, owner.apiKey, `?limit=1&before=${encodeURIComponent(first.nextBefore)}`)).data;
    expect(second.pulls.length).toBe(1);
    expect(second.pulls[0].id).not.toBe(first.pulls[0].id);
  });

  it("names the person and the agent only for callers who can see editors", async () => {
    const asEditor = (await pulls(app, nestId, editor.apiKey)).data;
    expect(asEditor.identities).toBe(true);
    expect(asEditor.pulls.some((p: any) => p.actor === "editor@fernhill.test")).toBe(true);

    const asViewer = await pulls(app, nestId, viewer.apiKey);
    expect(asViewer.status).toBe(200);
    expect(asViewer.data.identities).toBe(false);
    expect(asViewer.data.pulls.length).toBeGreaterThan(0);
    for (const p of asViewer.data.pulls) {
      expect(p.actor).toBeNull();
      expect(p.agent).toBeNull();
    }
    expect(JSON.stringify(asViewer.data)).not.toContain("editor@fernhill.test");
    expect(JSON.stringify(asViewer.data)).not.toContain("Support Copilot");
    // …and an agent filter can't be used to probe for who pulled.
    const probe = await pulls(app, nestId, viewer.apiKey, "?agent=support%20copilot");
    expect(probe.data.pulls).toEqual([]);
  });

  it("names no one to a read-only key, whoever owns it (REST and MCP)", async () => {
    const k = await jsonRequest(app, "POST", "/auth/keys", { label: "ro-pulls", nest_id: nestId, capability: "read" }, owner.apiKey);
    expect(k.status).toBeLessThan(300);
    const ro = k.data.api_key as string;

    const rest = await pulls(app, nestId, ro);
    expect(rest.status).toBe(200);
    expect(rest.data.identities).toBe(false);
    expect(rest.data.pulls.length).toBeGreaterThan(0);
    expect(rest.data.pulls.every((p: any) => p.actor === null && p.agent === null)).toBe(true);
    expect(JSON.stringify(rest.data)).not.toContain("editor@fernhill.test");

    const tool = await callTool(app, nestId, ro, "context_pull_log", { limit: 5 });
    expect(tool.isError).toBeFalsy();
    expect(tool.structuredContent.identities).toBe(false);
    expect(tool.structuredContent.pulls.every((p: any) => p.actor === null && p.agent === null)).toBe(true);
  });

  it("gives agents the same log and trace over MCP (context_pull_log)", async () => {
    const rest = (await pulls(app, nestId, owner.apiKey, "?limit=5")).data;
    const list = await callTool(app, nestId, owner.apiKey, "context_pull_log", { limit: 5 });
    expect(list.isError).toBeFalsy();
    expect(list.structuredContent.pulls).toEqual(rest.pulls);
    expect(list.content[0].text).toContain("context_search");

    const one = await callTool(app, nestId, owner.apiKey, "context_pull_log", { pull_id: rest.pulls[1].id });
    expect(one.isError).toBeFalsy();
    expect(one.structuredContent.pull).toEqual(rest.pulls[1]);

    const hidden = await callTool(app, nestId, viewer.apiKey, "context_pull_log", { limit: 5 });
    expect(hidden.structuredContent.pulls.every((p: any) => p.actor === null && p.agent === null)).toBe(true);
    // Without identities the summary names no one, rather than "by someone".
    expect(hidden.content[0].text).not.toContain(" by ");
    expect(hidden.content[0].text).toContain("context_search:");
  });

  it("does not record a call to the pull log itself as a pull", async () => {
    const before = (await pulls(app, nestId, owner.apiKey, "?limit=50")).data.pulls.length;
    await callTool(app, nestId, owner.apiKey, "context_pull_log", {});
    expect((await pulls(app, nestId, owner.apiKey, "?limit=50")).data.pulls.length).toBe(before);
  });

  it("is empty, and says so, while the nest's access log is off", async () => {
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { access_log_enabled: false }, owner.apiKey);
    forgetAccessLogSetting();
    resetAccessThrottle();
    const before = (await pulls(app, nestId, owner.apiKey, "?limit=50")).data;
    expect(before.accessLogEnabled).toBe(false);
    await callTool(app, nestId, editor.apiKey, "context_get", { id: ids["Warranty Terms"], client: { agent: "Quiet" } });
    const after = (await pulls(app, nestId, owner.apiKey, "?limit=50")).data;
    expect(after.pulls.length).toBe(before.pulls.length);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { access_log_enabled: true }, owner.apiKey);
    forgetAccessLogSetting();
  });
});

describe("context pull log — public readers and access keys", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let stranger: { apiKey: string };
  let nestId: string;
  let openDoc: string;
  let draftDoc: string;
  let accessKey: string;
  let keyNestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@pub.test", "Owner");
    stranger = await registerUser(app, "stranger@pub.test", "Stranger");
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Public Pulls" }, owner.apiKey)).data.nest.id;
    openDoc = (await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Open Doc", content: "# Open\n\nheron public" }, owner.apiKey)).data.node.id;
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey);
    draftDoc = (await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Draft Doc", content: "# Draft\n\nheron private" }, owner.apiKey)).data.node.id;
    const vis = await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
    expect(vis.status).toBe(200);
    // Headless publishing is for a private nest: a second one, pulled from too.
    keyNestId = (await jsonRequest(app, "POST", "/nests", { name: "Partner Pulls" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "POST", `/nests/${keyNestId}/nodes`, { title: "Partner Doc", content: "# Partner\n\nheron" }, owner.apiKey);
    expect((await jsonRequest(app, "PUT", `/nests/${keyNestId}/headless`, { enabled: true }, owner.apiKey)).status).toBe(200);
    accessKey = (await jsonRequest(app, "POST", `/nests/${keyNestId}/headless/keys`, { label: "Partner" }, owner.apiKey)).data.api_key;
    expect(accessKey).toBeTruthy();

    resetAccessThrottle();
    // The owner (over REST, which serves members the working copy) pulls both
    // documents, then opens only the draft.
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/search?q=heron`, undefined, owner.apiKey)).status).toBe(200);
    expect((await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${draftDoc}`, undefined, owner.apiKey)).status).toBe(200);
    await callTool(app, keyNestId, owner.apiKey, "context_search", { query: "heron", client: { agent: "Owner Agent" } });
    await flushAccessLog();
  });

  afterAll(() => env.cleanup());

  it("shows a public reader only the documents they can read, with no person, agent or version", async () => {
    const own = (await pulls(app, nestId, owner.apiKey)).data.pulls;
    expect(own.length).toBe(2);
    expect(own.find((p: any) => p.tool === "search").steps.map((s: any) => s.nodeId).sort()).toEqual([draftDoc, openDoc].sort());

    const { status, data } = await pulls(app, nestId, stranger.apiKey);
    expect(status).toBe(200);
    expect(data.identities).toBe(false);
    // The draft-only pull is not listed at all; the search shows only the open doc.
    expect(data.pulls.length).toBe(1);
    expect(data.pulls[0].steps.map((s: any) => s.nodeId)).toEqual([openDoc]);
    expect(data.pulls[0].documents).toBe(1);
    expect(data.pulls[0]).toEqual(expect.objectContaining({ actor: null, agent: null }));
    expect(data.pulls[0].steps[0].version).toBeNull();
    expect(JSON.stringify(data)).not.toContain(draftDoc);
    expect(JSON.stringify(data)).not.toContain("owner@pub.test");
  });

  it("refuses the route and the tool to a headless access key", async () => {
    // The key reads its nest…
    expect((await jsonRequest(app, "GET", `/nests/${keyNestId}/search?q=heron`, undefined, accessKey)).status).toBe(200);
    // …but not who pulled from it, over REST or MCP.
    const r = await jsonRequest(app, "GET", `/nests/${keyNestId}/pulls`, undefined, accessKey);
    expect([403, 404]).toContain(r.status);
    const t = await callTool(app, keyNestId, accessKey, "context_pull_log", {});
    expect(t.isError).toBe(true);
    expect(JSON.stringify(t)).not.toContain("owner@pub.test");
  });
});

describe("context pull log — paging, large pulls and older rows", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let stranger: { apiKey: string };
  let openNest: string;
  let pubNest: string;
  let openDoc: string;
  let draftDoc: string;
  // The post-createTestApp module graph: the one the app writes through.
  let log: typeof import("../src/governance/access-log.js");
  let db: () => any;
  let pullLog: typeof import("../src/governance/pull-log-service.js");

  const walk = async (nestId: string, key: string, limit: number) => {
    const seen: any[] = [];
    const pages: any[] = [];
    let before = "";
    for (let i = 0; i < 50; i++) {
      const page = (await pulls(app, nestId, key, `?limit=${limit}${before ? `&before=${before}` : ""}`)).data;
      pages.push(page);
      seen.push(...page.pulls);
      if (!page.hasMore) break;
      expect(page.nextBefore).toBeTruthy();
      before = encodeURIComponent(page.nextBefore);
    }
    return { seen, pages };
  };

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    log = await import("../src/governance/access-log.js");
    pullLog = await import("../src/governance/pull-log-service.js");
    const client = await import("../src/db/client.js");
    db = () => client.getDb();
    owner = await registerUser(app, "owner@pages.test", "Owner");
    stranger = await registerUser(app, "stranger@pages.test", "Stranger");
    openNest = (await jsonRequest(app, "POST", "/nests", { name: "Paging" }, owner.apiKey)).data.nest.id;
    pubNest = (await jsonRequest(app, "POST", "/nests", { name: "Paging Public" }, owner.apiKey)).data.nest.id;
    openDoc = (await jsonRequest(app, "POST", `/nests/${pubNest}/nodes`, { title: "Open Doc", content: "# Open\n\nkestrel" }, owner.apiKey)).data.node.id;
    await jsonRequest(app, "PATCH", `/nests/${pubNest}/settings`, { stewardship_enabled: true }, owner.apiKey);
    draftDoc = (await jsonRequest(app, "POST", `/nests/${pubNest}/nodes`, { title: "Draft Doc", content: "# Draft\n\nkestrel" }, owner.apiKey)).data.node.id;
    const vis = await jsonRequest(app, "PATCH", `/nests/${pubNest}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
    expect(vis.status).toBe(200);
  });

  afterAll(() => env.cleanup());

  const record = (nestId: string, nodeIds: string[], detail: string, action: "retrieve" | "export" = "retrieve") =>
    log.recordNodeAccess({
      nestId,
      nodeIds,
      action,
      surface: "api",
      userEmail: "owner@pages.test",
      detail,
      unthrottled: true,
    });

  it("records a pull past the per-call cap as its first 50 documents, in order", async () => {
    const docs = Array.from({ length: 60 }, (_, i) => `cap-${String(i).padStart(2, "0")}`);
    record(openNest, docs, "search");
    await log.flushAccessLog();
    const p = (await pulls(app, openNest, owner.apiKey, "?limit=1")).data.pulls[0];
    expect(p.documents).toBe(log.MAX_PER_CALL);
    expect(p.steps.map((s: any) => s.nodeId)).toEqual(docs.slice(0, log.MAX_PER_CALL));
    expect(p.steps.map((s: any) => s.seq)).toEqual(docs.slice(0, log.MAX_PER_CALL).map((_, i) => i));
  });

  it("numbers seq across insert chunks, under one pull id", async () => {
    const docs = Array.from({ length: 250 }, (_, i) => `exp-${i}`);
    record(openNest, docs, "export", "export");
    await log.flushAccessLog();
    const rows = (await db().all(
      "SELECT pull_id, seq, node_id FROM node_access_events WHERE nest_id = ? AND action = 'export' ORDER BY seq",
      [openNest],
    )) as Array<{ pull_id: string; seq: number; node_id: string }>;
    expect(rows.length).toBe(250);
    expect(new Set(rows.map((r) => r.pull_id)).size).toBe(1);
    expect(rows.map((r) => Number(r.seq))).toEqual(docs.map((_, i) => i));
    expect(rows.map((r) => r.node_id)).toEqual(docs);
  });

  it("pages across a full row window without splitting or dropping a pull", async () => {
    // limit=1 reads a 100-row window; four 30-document pulls overflow it, so
    // the oldest pull in each window is cut and must come back whole on a later page.
    const made: string[][] = [];
    for (let k = 0; k < 4; k++) {
      const docs = Array.from({ length: 30 }, (_, i) => `win-${k}-${i}`);
      made.push(docs);
      record(openNest, docs, `query-${k}`);
      await log.flushAccessLog();
    }
    const { seen } = await walk(openNest, owner.apiKey, 1);
    const windowed = seen.filter((p) => String(p.tool).startsWith("query-"));
    expect(windowed.map((p) => p.tool)).toEqual(["query-3", "query-2", "query-1", "query-0"]);
    for (const p of windowed) expect(p.steps.map((s: any) => s.nodeId)).toEqual(made[Number(p.tool.slice(-1))]);
    expect(new Set(seen.map((p) => p.id)).size).toBe(seen.length);
  });

  it("reads past a full window of pulls this caller can't see instead of returning an empty page", async () => {
    record(pubNest, [openDoc], "search");
    await log.flushAccessLog();
    for (let i = 0; i < 150; i++) record(pubNest, [draftDoc], "context_get");
    await log.flushAccessLog();
    const first = (await pulls(app, pubNest, stranger.apiKey, "?limit=1")).data;
    expect(first.pulls.map((p: any) => p.steps.map((s: any) => s.nodeId))).toEqual([[openDoc]]);
  });

  it("still hands back a cursor when a page comes back empty, and the walk reaches the readable pull", async () => {
    for (let i = 0; i < 500; i++) record(pubNest, [draftDoc], "context_get");
    await log.flushAccessLog();
    const { seen, pages } = await walk(pubNest, stranger.apiKey, 1);
    for (const page of pages) if (page.hasMore) expect(page.nextBefore).toBeTruthy();
    expect(seen.map((p) => p.steps.map((s: any) => s.nodeId))).toEqual([[openDoc]]);
    expect(JSON.stringify(seen)).not.toContain(draftDoc);
  });

  it("groups pre-093 rows by call, and reads one back by its legacy id", async () => {
    const ts = "2020-01-02T03:04:05.678Z";
    const insert = (nodeId: string, detail: string) =>
      db().run(
        `INSERT INTO node_access_events (ts, nest_id, node_id, action, surface, user_email, detail)
         VALUES (?, ?, ?, 'retrieve', 'api', 'owner@pages.test', ?)`,
        [ts, openNest, nodeId, detail],
      );
    await insert("legacy-a", "search");
    await insert("legacy-b", "search");
    await insert("legacy-c", "context");
    const legacy = (await walk(openNest, owner.apiKey, 50)).seen.filter((p) => p.id.startsWith("legacy-"));
    expect(legacy.map((p) => p.steps.map((s: any) => s.nodeId))).toEqual([["legacy-c"], ["legacy-a", "legacy-b"]]);
    for (const p of legacy) {
      expect(p.steps.every((s: any) => s.bytes === null && s.hop === null)).toBe(true);
      const one = await jsonRequest(app, "GET", `/nests/${openNest}/pulls/${p.id}`, undefined, owner.apiKey);
      expect(one.status).toBe(200);
      expect(one.data.pull).toEqual(p);
    }
    // A legacy id names its group's first row; the second row's id is not a pull.
    const searchId = Number(legacy[1].id.slice("legacy-".length));
    const notAPull = await jsonRequest(app, "GET", `/nests/${openNest}/pulls/legacy-${searchId + 1}`, undefined, owner.apiKey);
    expect(notAPull.status).toBe(404);
  });

  it("lists each distinct pull of a document in its activity log, and an identical repeat once", async () => {
    log.resetAccessThrottle();
    const at = (nodeIds: string[], detail: string) =>
      log.recordNodeAccess({ nestId: openNest, nodeIds, action: "retrieve", surface: "mcp", userEmail: "owner@pages.test", detail });
    at(["act-doc"], "context_get");
    at(["act-doc"], "context_get");
    at(["act-doc", "act-other"], "context_search");
    await log.flushAccessLog(openNest);
    const r = await jsonRequest(app, "GET", `/nests/${openNest}/activity-log?node=act-doc&type=retrieved`, undefined, owner.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.items.map((i: any) => i.detail).sort()).toEqual(["context_get", "context_search"]);
  });

  it("blanks a via that names a document the reader can't see, keeping the hop", async () => {
    // A traversal from the draft (unreadable to a public reader) to the open doc.
    log.recordNodeAccess({
      nestId: pubNest,
      nodeIds: [draftDoc, openDoc],
      action: "retrieve",
      surface: "api",
      userEmail: "owner@pages.test",
      detail: "context",
      hops: { [draftDoc]: { hop: 0 }, [openDoc]: { hop: 1, via: draftDoc } },
      unthrottled: true,
    });
    await log.flushAccessLog(pubNest);
    const asOwner = (await pulls(app, pubNest, owner.apiKey, "?limit=1")).data.pulls[0];
    expect(asOwner.steps.find((s: any) => s.nodeId === openDoc)).toEqual(expect.objectContaining({ hop: 1, via: draftDoc }));
    const asStranger = (await pulls(app, pubNest, stranger.apiKey, "?limit=1")).data.pulls[0];
    expect(asStranger.tool).toBe("context");
    expect(asStranger.steps).toEqual([expect.objectContaining({ nodeId: openDoc, hop: 1, via: null })]);
    expect(JSON.stringify(asStranger)).not.toContain(draftDoc);
  });

  it("rejects a non-numeric limit or cursor with a 400", async () => {
    for (const q of ["?limit=abc", "?limit=0", "?limit=2.5", "?before=abc"]) {
      const r = await jsonRequest(app, "GET", `/nests/${openNest}/pulls${q}`, undefined, owner.apiKey);
      expect(r.status, q).toBe(400);
    }
    expect((await jsonRequest(app, "GET", `/nests/${openNest}/pulls?limit=500`, undefined, owner.apiKey)).status).toBe(200);
  });

  it("flushes only the asked nest's in-flight inserts before a read", async () => {
    // An insert for another nest that never settles must not hold up this one.
    const state = (globalThis as any)[Symbol.for("contextnest.accessLog")];
    const stuck = new Promise<void>(() => {});
    state.pending.set(stuck, "some-other-nest");
    try {
      const settled = await Promise.race([
        log.flushAccessLog(openNest).then(() => "flushed"),
        new Promise((r) => setTimeout(() => r("waited"), 500)),
      ]);
      expect(settled).toBe("flushed");
      const listed = await Promise.race([
        jsonRequest(app, "GET", `/nests/${openNest}/pulls?limit=1`, undefined, owner.apiKey).then((r) => r.status),
        new Promise((r) => setTimeout(() => r("waited"), 2000)),
      ]);
      expect(listed).toBe(200);
    } finally {
      state.pending.delete(stuck);
    }
  });

  it("treats only a missing access log or 093 column as \"no pulls\" — any other schema error surfaces", async () => {
    const errorOf = (sql: string) => db().all(sql).then(() => null, (e: unknown) => e);
    for (const sql of ["SELECT pull_id FROM node_access_events_gone", "SELECT bytes FROM nests"]) {
      const err = await errorOf(sql);
      expect(err, sql).toBeTruthy();
      expect(pullLog.isMissingSchemaError(err), sql).toBe(true);
    }
    for (const sql of ["SELECT 1 FROM some_unrelated_table", "SELECT no_such_column FROM users"]) {
      const err = await errorOf(sql);
      expect(err, sql).toBeTruthy();
      expect(pullLog.isMissingSchemaError(err), sql).toBe(false);
    }
    expect(pullLog.isMissingSchemaError(new Error("connection reset"))).toBe(false);
  });

  it("prunes rows past retention as pull volume is written", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await db().run(
      `INSERT INTO node_access_events (ts, nest_id, node_id, action, surface, user_email, detail)
       VALUES (?, ?, 'ancient-doc', 'retrieve', 'api', 'owner@pages.test', 'search')`,
      [old, openNest],
    );
    // PRUNE_EVERY (500) rows of distinct pulls: eleven 50-document searches.
    for (let k = 0; k < 11; k++) record(openNest, Array.from({ length: 50 }, (_, i) => `vol-${k}-${i}`), `search-${k}`);
    await log.flushAccessLog(openNest);
    const left = await db().get("SELECT COUNT(*) AS n FROM node_access_events WHERE node_id = 'ancient-doc'");
    expect(Number((left as any).n)).toBe(0);
  });
});
