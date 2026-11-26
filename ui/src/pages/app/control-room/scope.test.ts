import { describe, expect, it } from "vitest";
import { ALL_NESTS, nestOptions } from "./scope";

describe("po-1438: the Control Room nest picker", () => {
  it("lists All nests first, then every nest, each with its own value", () => {
    const options = nestOptions([{ id: "a", name: "Same" }, { id: "b", name: "Same" }]);
    expect(options[0]).toEqual({ value: ALL_NESTS, label: "All nests" });
    expect(options.map((o) => o.value)).toEqual([ALL_NESTS, "a", "b"]);
  });
  it("offers All nests when there are none", () => {
    expect(nestOptions([])).toHaveLength(1);
  });
});
