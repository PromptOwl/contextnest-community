/**
 * Regression pins for table `:ref` columns — the behaviour a table WITHOUT a
 * ref column, and a plain body [[wikilink]], had before ref columns existed.
 * Written (and green) before the feature; they must stay green after it.
 *  - parse: column shape and rows of a ref-less table are unchanged
 *  - query: a plain text column holding `[[…]]` text compares as raw text,
 *    never by resolved target
 *  - graph: wikilinks (in prose or in a plain table cell) stay untyped edges
 *  - backlinks: a table linking by wikilink is a plain {id, title} backlink
 *  - create/update responses carry no new keys for documents or ref-less tables
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { parseTable, parseQuery, runQuery } from "../src/tables/service.js";
import { findBacklinks } from "../ui/src/lib/backlinks";

const PLAIN = `id:key, notes, amount:number, closed:date
r1, [[Beta]], 10, 2026-01-01
r2, Beta, 20, 2026-02-01
r3, , 30, 2026-03-01`;

describe("ref-less table parse + query (unchanged)", () => {
  const t = parseTable(PLAIN);

  it("parses columns to exactly {name, type, key}", () => {
    expect(t.columns).toEqual([
      { name: "id", type: "text", key: true },
      { name: "notes", type: "text", key: false },
      { name: "amount", type: "number", key: false },
      { name: "closed", type: "date", key: false },
    ]);
    expect(t.rows).toEqual([
      ["r1", "[[Beta]]", "10", "2026-01-01"],
      ["r2", "Beta", "20", "2026-02-01"],
      ["r3", "", "30", "2026-03-01"],
    ]);
  });

  it("a plain column compares raw text: [[Beta]] = [[Beta]] only", () => {
    expect(runQuery(t, parseQuery("where notes = [[Beta]] select id")).rows).toEqual([["r1"]]);
    expect(runQuery(t, parseQuery("where notes = Beta select id")).rows).toEqual([["r2"]]);
    expect(runQuery(t, parseQuery("where notes != Beta select id")).rows).toEqual([["r1"], ["r3"]]);
    expect(runQuery(t, parseQuery('where notes contains "beta" select id')).rows).toEqual([
      ["r1"],
      ["r2"],
    ]);
  });

  it("number/date/limit behave as before", () => {
    const r = runQuery(t, parseQuery("where amount >= 20 and closed < 2026-03-01 select id limit 5"));
    expect(r).toEqual({ columns: ["id"], rows: [["r2"]], matched: 1, total: 3 });
  });
});

describe("ref-less backlinks (unchanged)", () => {
  it("a table linking by wikilink is a plain {id, title} backlink", () => {
    const nodes = [
      { id: "nodes/beta", title: "Beta", content: "" },
      { id: "nodes/plain", title: "Plain", content: PLAIN, type: "table" },
      { id: "nodes/doc", title: "Doc", content: "See [[beta]]." },
    ];
    expect(findBacklinks(nodes, { id: "nodes/beta", title: "Beta" })).toEqual([
      { id: "nodes/plain", title: "Plain" },
      { id: "nodes/doc", title: "Doc" },
    ]);
  });
});

describe("ref-less graph + write responses (unchanged)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;
  let created: Record<string, any>;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@reg.test", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Reg" }, owner.apiKey);
    nestId = nest.data.nest.id;
    created = {};
    for (const [title, content, type] of [
      ["Beta", "Body.", undefined],
      ["Alpha", "See [[Beta]].", undefined],
      ["Plain", PLAIN, "table"],
    ] as const) {
      const res = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title, content, ...(type ? { type } : {}) },
        owner.apiKey,
      );
      expect(res.status).toBe(201);
      created[title] = res.data;
    }
  });

  afterAll(() => env.cleanup());

  it("create responses for a document and a ref-less table have the same keys as before", () => {
    expect(Object.keys(created.Alpha).sort()).toEqual(["node"]);
    expect(Object.keys(created.Plain).sort()).toEqual(["node"]);
  });

  it("update response for a ref-less table has the same keys as before", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/plain`,
      { content: PLAIN + "\nr4, x, 1, 2026-04-01" },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.data).sort()).toEqual(["node", "version"]);
  });

  it("prose and plain-cell wikilinks are untyped {source, target} edges", async () => {
    const { status, data } = await jsonRequest(app, "GET", `/nests/${nestId}/graph`, undefined, owner.apiKey);
    expect(status).toBe(200);
    const sorted = [...data.links].sort((a: any, b: any) => a.source.localeCompare(b.source));
    expect(sorted).toEqual([
      { source: "nodes/alpha", target: "nodes/beta" },
      { source: "nodes/plain", target: "nodes/beta" },
    ]);
  });

  it("a ref-less table queries the same over REST", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/table-query`,
      { table: "[[Plain]]", query: "where notes = [[Beta]] select id" },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.rows).toEqual([["r1"]]);
  });
});
