/**
 * Coverage Gaps on the Graph tab must not claim "Every category has a
 * steward" for a nest that has no categories to cover (CU-wdqcq027fu).
 */
import { describe, it, expect } from "vitest";
import { categoryCoverageEmpty } from "./coverage-gaps";

describe("categoryCoverageEmpty", () => {
  it("reports full coverage only when there are categories to cover", () => {
    expect(categoryCoverageEmpty(3, 0)).toBe("Every category has a steward.");
    expect(categoryCoverageEmpty(1, 2)).toBe("Every category has a steward.");
  });
  it("names the missing categories when stewards exist but nothing is tagged", () => {
    expect(categoryCoverageEmpty(0, 2)).toMatch(/^No categories yet/);
  });
  it("names both when the nest has neither categories nor stewards", () => {
    expect(categoryCoverageEmpty(0, 0)).toMatch(/^No categories or stewards yet/);
  });
});
