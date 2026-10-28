/**
 * Table `:ref` columns link rows into the graph.
 *
 * Ticket: Engineering Ops nest, nodes/projects/tasks/
 *   community-nest-table-ref-columns-link-rows-into-the-graph
 *
 * A `:ref` column holds `[[Title]]`, `[[path|label]]` or a bare node id. Every
 * non-empty ref cell is an edge from the table to the target, typed by the
 * column name and attributed to the row key:
 *  - AC1 the graph shows an `account` edge Pipeline → AGA carrying row r1
 *  - AC2 AGA's backlinks list the table with the edge type and row key
 *  - AC3 `where account = [[AGA]]` matches by resolved target (title/path/id)
 *  - AC4 an unresolved ref doesn't block the save; the response lists it
 *  - AC6 a reader who can't see the target gets no edge and no title for it
 * (AC5, the ref-less regression, lives in table-ref-regression.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import {
  parseTable,
  parseQuery,
  runQuery,
  parseRefTarget,
  extractTableRefs,
} from "../src/tables/service.js";
import { findBacklinks } from "../ui/src/lib/backlinks";

const PIPELINE = `id:key,account:ref,amount:number
r1,[[AGA]],10
r2,,20
r3,[[nodes/aga|Acme Group]],30
r4,nodes/aga,40
r5,[[Other Co]],50`;

type User = { apiKey: string; userId: string; email: string };

async function mcpCall(
  app: any,
  nestId: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; data: any; isError: boolean }> {
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
      params: { name, arguments: args },
    }),
  });
  const ct = res.headers.get("content-type") || "";
  let body: any;
  if (ct.includes("application/json")) body = await res.json();
  else {
    const raw = await res.text();
    const dataLine = raw.split("\n").find((l: string) => l.startsWith("data: "));
    body = dataLine ? JSON.parse(dataLine.slice("data: ".length)) : raw;
  }
  const text = (body?.result?.content ?? []).map((c: any) => c.text).join("");
  return {
    text,
    data: body?.result?.structuredContent,
    isError: body?.result?.isError === true,
  };
}

describe(":ref directive — parse", () => {
  it("marks ref columns and keeps them text-typed", () => {
    const t = parseTable(PIPELINE);
    expect(t.columns[1]).toEqual({ name: "account", type: "text", key: false, ref: true });
    expect(t.columns[0].ref).toBeUndefined();
  });

  it("combines with :key", () => {
    const t = parseTable("deal:key:ref\n[[AGA]]");
    expect(t.columns[0]).toMatchObject({ key: true, ref: true });
  });

  it("reads the target out of [[Title]], [[path|label]] and a bare id", () => {
    expect(parseRefTarget("[[AGA]]")).toBe("AGA");
    expect(parseRefTarget(" [[nodes/aga | Acme]] ")).toBe("nodes/aga");
    expect(parseRefTarget("nodes/aga")).toBe("nodes/aga");
    expect(parseRefTarget("")).toBeNull();
    expect(parseRefTarget("  ")).toBeNull();
    expect(parseRefTarget("[[ ]]")).toBeNull();
  });

  it("extracts one ref per non-empty ref cell, attributed to the row key", () => {
    expect(extractTableRefs(parseTable(PIPELINE))).toEqual([
      { column: "account", row: "r1", target: "AGA" },
      { column: "account", row: "r3", target: "nodes/aga" },
      { column: "account", row: "r4", target: "nodes/aga" },
      { column: "account", row: "r5", target: "Other Co" },
    ]);
  });

  it("falls back to the row number when there is no key column (or the key is blank)", () => {
    expect(extractTableRefs(parseTable("owner:ref,n\n[[A]],1\n[[B]],2"))).toEqual([
      { column: "owner", row: "row 1", target: "A" },
      { column: "owner", row: "row 2", target: "B" },
    ]);
    expect(extractTableRefs(parseTable("id:key,owner:ref\n,[[A]]"))).toEqual([
      { column: "owner", row: "row 1", target: "A" },
    ]);
  });
});

describe(":ref directive — query by resolved target (pure)", () => {
  const t = parseTable(PIPELINE);
  const resolve = (target: string) => {
    const k = target.toLowerCase();
    return k === "aga" || k === "nodes/aga" || k === "aga-slug" ? "nodes/aga" : null;
  };

  it("matches title, path and id spellings of the same target", () => {
    for (const v of ["[[AGA]]", "[[nodes/aga]]", "nodes/aga", "[[aga|anything]]"]) {
      const r = runQuery(t, parseQuery(`where account = ${v} select id`), resolve);
      expect(r.rows, v).toEqual([["r1"], ["r3"], ["r4"]]);
    }
  });

  it("!= is the complement (empty cells included)", () => {
    const r = runQuery(t, parseQuery("where account != [[AGA]] select id"), resolve);
    expect(r.rows).toEqual([["r2"], ["r5"]]);
  });

  it("an unresolved target still matches the same written target", () => {
    const r = runQuery(t, parseQuery("where account = [[other co]] select id"), resolve);
    expect(r.rows).toEqual([["r5"]]);
  });

  it("without a resolver, compares the written target text", () => {
    const r = runQuery(t, parseQuery("where account = [[AGA]] select id"));
    expect(r.rows).toEqual([["r1"]]);
  });
});

describe(":ref backlinks (UI)", () => {
  it("lists the table with the edge type and row keys", () => {
    const nodes = [
      { id: "nodes/aga", title: "AGA", content: "", type: "document" },
      { id: "nodes/pipeline", title: "Pipeline", content: PIPELINE, type: "table" },
      { id: "nodes/doc", title: "Doc", content: "See [[AGA]]." },
    ];
    expect(findBacklinks(nodes, { id: "nodes/aga", title: "AGA" })).toEqual([
      {
        id: "nodes/pipeline",
        title: "Pipeline",
        refs: [{ column: "account", rows: ["r1", "r3", "r4"] }],
      },
      { id: "nodes/doc", title: "Doc" },
    ]);
  });

  it("a bare-id ref cell alone (no [[…]]) is a backlink", () => {
    const nodes = [
      { id: "nodes/t", title: "T", content: "id:key,owner:ref\nx1,nodes/aga", type: "table" },
    ];
    expect(findBacklinks(nodes, { id: "nodes/aga", title: "AGA" })).toEqual([
      { id: "nodes/t", title: "T", refs: [{ column: "owner", rows: ["x1"] }] },
    ]);
  });
});

describe(":ref columns over REST, MCP and the graph", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let nestId: string;
  let createRes: any;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@ref.test", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "CRM" }, owner.apiKey);
    nestId = nest.data.nest.id;
    expect(
      (await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "AGA", content: "Account." }, owner.apiKey)).status,
    ).toBe(201);
    expect(
      (await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Other Co", content: "Account." }, owner.apiKey)).status,
    ).toBe(201);
    createRes = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Pipeline", content: PIPELINE, type: "table" },
      owner.apiKey,
    );
    expect(createRes.status).toBe(201);
  });

  afterAll(() => env.cleanup());

  it("AC1: the graph has a typed `account` edge to AGA carrying its rows, and no untyped duplicate", async () => {
    const { status, data } = await jsonRequest(app, "GET", `/nests/${nestId}/graph`, undefined, owner.apiKey);
    expect(status).toBe(200);
    const fromTable = data.links.filter((l: any) => l.source === "nodes/pipeline");
    expect(fromTable).toEqual(
      expect.arrayContaining([
        { source: "nodes/pipeline", target: "nodes/aga", type: "account", rows: ["r1", "r3", "r4"] },
        { source: "nodes/pipeline", target: "nodes/other-co", type: "account", rows: ["r5"] },
      ]),
    );
    expect(fromTable).toHaveLength(2);
  });

  it("AC3: where account = [[AGA]] returns the AGA rows whether written as title, path or id", async () => {
    for (const v of ["[[AGA]]", "[[nodes/aga]]", "nodes/aga", "[[aga]]"]) {
      const res = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/table-query`,
        { table: "[[Pipeline]]", query: `where account = ${v} select id`, include_drafts: true },
        owner.apiKey,
      );
      expect(res.status, v).toBe(200);
      expect(res.data.rows, v).toEqual([["r1"], ["r3"], ["r4"]]);
    }
  });

  it("AC3 over MCP: context_table_query resolves the same way", async () => {
    const out = await mcpCall(app, nestId, owner.apiKey, "context_table_query", {
      table: "[[Pipeline]]",
      query: "where account = [[AGA]] select id",
      include_drafts: true,
    });
    expect(out.isError).toBe(false);
    // Prose result: a header line, then the CSV (column header + rows).
    expect(out.text.split("\n").slice(1)).toEqual(["id", "r1", "r3", "r4"]);
  });

  it("AC4: create reports refs and none unresolved when all resolve", () => {
    // AGA and Other Co both exist; the empty r2 cell is not a ref.
    expect(createRes.data.table_refs).toEqual({ total: 4, unresolved: [] });
  });

  it("AC4: an update adding [[Nope]] saves and lists it as unresolved", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/pipeline`,
      { content: PIPELINE + "\nr6,[[Nope]],5" },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.version).toBeGreaterThan(0);
    expect(res.data.table_refs).toEqual({
      total: 5,
      unresolved: [{ column: "account", row: "r6", target: "Nope" }],
    });
    // The graph draws no edge for it.
    const g = await jsonRequest(app, "GET", `/nests/${nestId}/graph`, undefined, owner.apiKey);
    expect(g.data.links.filter((l: any) => l.source === "nodes/pipeline")).toHaveLength(2);
  });

  it("AC4 over MCP: context_create and context_update report unresolved refs", async () => {
    const made = await mcpCall(app, nestId, owner.apiKey, "context_create", {
      title: "Deals",
      type: "table",
      content: "id:key,account:ref\nd1,[[AGA]]\nd2,[[Ghost]]",
    });
    expect(made.isError).toBe(false);
    expect(made.data.table_refs).toEqual({
      total: 2,
      unresolved: [{ column: "account", row: "d2", target: "Ghost" }],
    });
    expect(made.text).toMatch(/1 unresolved ref/);
    expect(made.text).toMatch(/Ghost/);

    const upd = await mcpCall(app, nestId, owner.apiKey, "context_update", {
      id: made.data.id,
      content: "id:key,account:ref\nd1,[[AGA]]",
    });
    expect(upd.isError).toBe(false);
    expect(upd.data.table_refs).toEqual({ total: 1, unresolved: [] });
    expect(upd.text).not.toMatch(/unresolved/);
  });
});

describe(":ref columns never leak a target the reader can't see (AC6)", () => {
  // The reader is a document grantee of the table only — the one caller
  // filterAccessible narrows to a slice of the nest (a steward-scoped viewer
  // resolves to a nest-wide reader). Grantees can't reach REST /graph or
  // /table-query (the nest middleware 404s/403s them before the handler), so
  // the reads run at the service layer every surface shares.
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let guest: User;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@leak.test", "Owner");
    guest = await registerUser(app, "guest@leak.test", "Guest");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Private CRM" }, owner.apiKey);
    nestId = nest.data.nest.id;
    for (const [title, content, type] of [
      ["AGA", "Account.", undefined],
      ["Other Co", "Account.", undefined],
      ["Pipeline", PIPELINE, "table"],
    ] as const) {
      const r = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title, content, ...(type ? { type } : {}) },
        owner.apiKey,
      );
      expect(r.status).toBe(201);
    }
    const g = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: "nodes/pipeline", email: guest.email, role: "read" },
      owner.apiKey,
    );
    expect(g.status).toBe(201);
  });

  afterAll(() => env.cleanup());

  it("the graph gives the grantee no edge and no title for the hidden targets", async () => {
    const { buildNestGraph } = await import("../src/nodes/graph-service.js");
    const graph = await buildNestGraph(nestId, guest.userId, guest.email, false);
    expect(graph.nodes.map((n) => n.id)).toEqual(["nodes/pipeline"]);
    expect(graph.links).toEqual([]);
    const json = JSON.stringify(graph);
    expect(json).not.toContain("nodes/aga");
    expect(json).not.toContain("nodes/other-co");
    // Control: the owner sees the typed edges.
    const full = await buildNestGraph(nestId, owner.userId, owner.email, true);
    expect(full.links.filter((l) => l.type === "account")).toHaveLength(2);
  });

  it("the grantee's query can't use a hidden node's title to match an id-written row", async () => {
    // r3/r4 point at AGA by path/id. The owner's [[AGA]] resolves to nodes/aga
    // and matches them; the grantee's can't resolve (AGA is hidden), so only
    // the row that literally says [[AGA]] matches — the query does not tell
    // them that "AGA" is nodes/aga.
    const { queryTableNode } = await import("../src/tables/query.js");
    const q = "where account = [[AGA]] select id";
    const asGuest = await queryTableNode(nestId, "nodes/pipeline", q, true, {
      userId: guest.userId,
      userEmail: guest.email,
      approvedOnly: false,
    });
    expect(asGuest.rows).toEqual([["r1"]]);
    const asOwner = await queryTableNode(nestId, "nodes/pipeline", q, true, {
      userId: owner.userId,
      userEmail: owner.email,
      approvedOnly: false,
    });
    expect(asOwner.rows).toEqual([["r1"], ["r3"], ["r4"]]);
  });

  it("a write report for a writer who can't see the target calls it unresolved", async () => {
    const { tableRefReport } = await import("../src/tables/refs.js");
    const report = await tableRefReport(
      nestId,
      { body: "id:key,account:ref\nx1,[[AGA]]", frontmatter: { type: "table" } as any },
      guest.userId,
      guest.email,
    );
    expect(report).toEqual({
      total: 1,
      unresolved: [{ column: "account", row: "x1", target: "AGA" }],
    });
  });
});
