import { describe, it, expect } from "vitest";
import { stageDot } from "./tones";

describe("stageDot", () => {
  it("colours a stage column on the all-tags board", () => {
    expect(stageDot("stage:in-review")).toBeTruthy();
  });

  it("colours the bare-value column when the board is grouped by stage:", () => {
    expect(stageDot("in-review", "stage")).toBe(stageDot("stage:in-review"));
    expect(stageDot("backlog", "stage")).not.toBe(stageDot("in-review", "stage"));
  });

  it("leaves other columns and namespaces uncoloured", () => {
    expect(stageDot("in-review")).toBeUndefined();
    expect(stageDot("community", "surface")).toBeUndefined();
  });
});
