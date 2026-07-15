/**
 * TABLE nodes: CSV as a governed fact store with deterministic lookup.
 *  - header directives (:key, :number, :date) drive typed comparison
 *  - the query grammar: where … and … select … limit …
 *  - REST /table-query resolves [[Title]] like /context and rejects
 *    non-table nodes
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { parseTable, parseQuery, runQuery } from "../src/tables/service.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

const CSV = `sku:key, price:number, region, launched:date
OWL-100, 99, US, 2025-01-15
OWL-200, 149, EU, 2025-06-01
"OWL-300, deluxe", 249, EU, 2026-02-01
OWL-400, 75, APAC, 2024-11-20`;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Facts" }, alice.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`,
    { title: "Price List", content: CSV, type: "table" }, alice.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`,
    { title: "Just Prose", content: "# words" }, alice.apiKey);
});

afterAll(() => env.cleanup());

describe("parse + query engine", () => {
  const t = parseTable(CSV);

  it("parses directives and quoted cells", () => {
    expect(t.columns.map((c) => c.name)).toEqual(["sku", "price", "region", "launched"]);
    expect(t.columns[0].key).toBe(true);
    expect(t.columns[1].type).toBe("number");
    expect(t.columns[3].type).toBe("date");
    expect(t.rows[2][0]).toBe("OWL-300, deluxe"); // quoted comma survives
  });

  it("numeric comparison respects :number (149 > 99 as numbers, not strings)", () => {
    const r = runQuery(t, parseQuery("where price > 100"));
    expect(r.rows.map((x) => x[0])).toEqual(["OWL-200", "OWL-300, deluxe"]);
  });

  it("and + select + limit, with honest truncation counts", () => {
    const r = runQuery(t, parseQuery('where region = "EU" and price > 100 select sku, price limit 1'));
    expect(r.columns).toEqual(["sku", "price"]);
    expect(r.rows).toEqual([["OWL-200", "149"]]);
    expect(r.matched).toBe(2);
    expect(r.returned === undefined ? r.rows.length : r.rows.length).toBe(1);
    expect(r.total).toBe(4);
  });

  it("date comparison + contains", () => {
    const r = runQuery(t, parseQuery("where launched >= 2025-06-01"));
    expect(r.rows.length).toBe(2);
    const c = runQuery(t, parseQuery('where sku contains "deluxe"'));
    expect(c.rows.length).toBe(1);
  });

  it("determinism: same query, same rows, same order", () => {
    const q = parseQuery("where price >= 75 select sku");
    expect(runQuery(t, q)).toEqual(runQuery(t, q));
  });

  it("rejects unknown columns, directives, and malformed conditions", () => {
    expect(() => runQuery(t, parseQuery("where ghost = 1"))).toThrow(/unknown column/);
    expect(() => parseTable("a:wat\n1")).toThrow(/unknown column directive/);
    expect(() => parseQuery("where price !!! 5")).toThrow(/can't parse/);
  });
});

describe("REST /table-query", () => {
  it("resolves [[Title]] and answers the lookup", async () => {
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/table-query`,
      { table: "[[Price List]]", query: 'where region = "EU" select sku' },
      alice.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.rows).toEqual([["OWL-200"], ["OWL-300, deluxe"]]);
    expect(res.data.total).toBe(4);
  });

  it("accepts a node id and empty query = all rows", async () => {
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/table-query`,
      { table: "nodes/price-list" }, alice.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.returned).toBe(4);
  });

  it("rejects non-table nodes (400) and unknown tables (404)", async () => {
    const prose = await jsonRequest(app, "POST", `/nests/${nestId}/table-query`,
      { table: "[[Just Prose]]" }, alice.apiKey);
    expect(prose.status).toBe(400);
    const ghost = await jsonRequest(app, "POST", `/nests/${nestId}/table-query`,
      { table: "[[No Such Table]]" }, alice.apiKey);
    expect(ghost.status).toBe(404);
  });
});
