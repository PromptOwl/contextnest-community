import { describe, it, expect } from "vitest";
import { summarizeChange } from "./change-summary";

const doc = (...l: string[]) => l.join("\n");

describe("summarizeChange", () => {
  it("says nothing differs for identical text", () => {
    const s = summarizeChange("# A\nbody", "# A\nbody");
    expect(s.unchanged).toBe(true);
    expect(s.added + s.removed).toBe(0);
    expect(s.text).toMatch(/no differences/i);
  });

  it("counts added and removed lines and names the section they sit in", () => {
    const before = doc("# Plan", "intro", "## Pricing", "old price", "## Support", "email");
    const after = doc("# Plan", "intro", "## Pricing", "new price", "extra line", "## Support", "email");
    const s = summarizeChange(before, after);
    expect(s.removed).toBe(1);
    expect(s.added).toBe(2);
    expect(s.sections).toEqual(["Pricing"]);
    expect(s.text).toBe("2 lines added, 1 line removed in 1 section: Pricing.");
  });

  it("names each changed section once, in document order", () => {
    const before = doc("# T", "a", "## One", "x", "## Two", "y");
    const after = doc("# T", "a!", "## One", "x!", "## Two", "y!");
    expect(summarizeChange(before, after).sections).toEqual(["T", "One", "Two"]);
  });

  it("calls text before the first heading the introduction", () => {
    const s = summarizeChange("hello", "hello there");
    expect(s.sections).toEqual(["Introduction"]);
  });

  it("collapses a long list of sections", () => {
    const before = doc("## A", "1", "## B", "1", "## C", "1", "## D", "1", "## E", "1");
    const after = doc("## A", "2", "## B", "2", "## C", "2", "## D", "2", "## E", "2");
    const s = summarizeChange(before, after);
    expect(s.sections).toHaveLength(5);
    expect(s.text).toContain("and 2 more");
  });

  it("reports a brand-new section as added under its own heading", () => {
    const s = summarizeChange("# Doc\nintro", "# Doc\nintro\n## New\nfresh");
    expect(s.removed).toBe(0);
    expect(s.sections).toContain("New");
  });
});
