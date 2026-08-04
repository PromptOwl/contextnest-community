import { describe, it, expect } from "vitest";
import { dbtSemanticToNodes } from "../src/definitions/dbt.js";

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
