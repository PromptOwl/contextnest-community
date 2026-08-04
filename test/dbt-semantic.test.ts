import { describe, it, expect } from "vitest";
import {
  dbtSemanticToNodes,
  dbtSemanticToEdges,
  dbtSemanticToStewards,
} from "../src/definitions/dbt.js";

// A parsed dbt semantic YAML doc (the YAML.load happens at the route layer;
// this mapper is pure and takes the already-parsed object).
const doc = {
  semantic_models: [
    {
      name: "orders",
      description: "One row per order",
      model: "ref('orders')",
      entities: [{ name: "order_id", type: "primary" }],
      dimensions: [{ name: "order_date", type: "time" }],
      measures: [{ name: "order_total", agg: "sum" }],
    },
    { name: "customers", model: "ref('customers')" },
    { name: "", model: "ref('nameless')" }, // skipped — no name
  ],
  metrics: [
    { name: "revenue", type: "simple", type_params: { measure: "order_total" } },
  ],
};

describe("dbtSemanticToNodes", () => {
  it("emits one node per named semantic_model and metric", () => {
    const nodes = dbtSemanticToNodes(doc);
    expect(nodes.map((n) => `${n.kind}:${n.title}`)).toEqual([
      "semantic_model:orders",
      "semantic_model:customers",
      "metric:revenue",
    ]);
  });

  it("carries the description and the raw entry through", () => {
    const orders = dbtSemanticToNodes(doc).find((n) => n.title === "orders")!;
    expect(orders.description).toBe("One row per order");
    expect((orders.entry as any).measures[0].name).toBe("order_total");
  });

  it("skips entries with no (or blank) name", () => {
    const nodes = dbtSemanticToNodes(doc);
    expect(nodes.some((n) => n.title === "")).toBe(false);
    expect(nodes).toHaveLength(3);
  });

  it("returns [] for junk / empty input", () => {
    expect(dbtSemanticToNodes(null)).toEqual([]);
    expect(dbtSemanticToNodes("nope")).toEqual([]);
    expect(dbtSemanticToNodes({})).toEqual([]);
    expect(dbtSemanticToNodes({ semantic_models: "not-an-array" })).toEqual([]);
  });
});

// Graph derivation: edges from the dbt structure.
const graphDoc = {
  semantic_models: [
    {
      name: "orders",
      entities: [{ name: "customer_id", type: "foreign" }],
      measures: [{ name: "order_total", agg: "sum" }],
      meta: { owner: "ana@acme.com" },
    },
    {
      name: "customers",
      entities: [{ name: "customer_id", type: "primary" }],
      owner: "growth-team", // not an email → not a resolvable steward
    },
  ],
  metrics: [
    {
      name: "revenue",
      type: "simple",
      type_params: { measure: "order_total" },
      meta: { owner: "ana@acme.com" },
    },
  ],
};

describe("dbtSemanticToEdges", () => {
  it("links a metric to the model that owns its measure", () => {
    const edges = dbtSemanticToEdges(graphDoc);
    expect(edges).toContainEqual({
      from: "revenue",
      to: "orders",
      type: "measures",
    });
  });
  it("joins models that share an entity (one edge per pair, deduped)", () => {
    const joins = dbtSemanticToEdges(graphDoc).filter((e) => e.type === "joins");
    expect(joins).toHaveLength(1);
    expect([joins[0].from, joins[0].to].sort()).toEqual(["customers", "orders"]);
  });
  it("returns [] for junk input", () => {
    expect(dbtSemanticToEdges(null)).toEqual([]);
    expect(dbtSemanticToEdges({})).toEqual([]);
  });
});

describe("dbtSemanticToStewards", () => {
  it("maps an email owner to a reviewer steward scoped to the entry", () => {
    const s = dbtSemanticToStewards(graphDoc);
    expect(s).toContainEqual({
      scope: "orders",
      email: "ana@acme.com",
      role: "reviewer",
    });
    expect(s).toContainEqual({
      scope: "revenue",
      email: "ana@acme.com",
      role: "reviewer",
    });
  });
  it("skips non-email owners (team names need resolution, not a steward)", () => {
    const s = dbtSemanticToStewards(graphDoc);
    expect(s.some((x) => x.scope === "customers")).toBe(false);
  });
  it("returns [] for junk input", () => {
    expect(dbtSemanticToStewards(null)).toEqual([]);
    expect(dbtSemanticToStewards({})).toEqual([]);
  });
});
