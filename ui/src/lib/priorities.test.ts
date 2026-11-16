import { describe, it, expect } from "vitest";
import { DEFAULT_PRIORITY_LEVELS as D, levelGlyph, levelLabel, levelRank, levelsOrDefault } from "./priorities.tsx";

describe("priority levels", () => {
  it("the defaults draw as alert / 3 / 2 / 1 bars", () => {
    expect(D.map((l) => levelGlyph(D, l.key))).toEqual([
      { kind: "alert" },
      { kind: "bars", filled: 3 },
      { kind: "bars", filled: 2 },
      { kind: "bars", filled: 1 },
    ]);
  });
  it("any number of levels stays ordered, never empty", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((k) => ({ key: k, label: k }));
    const bars = six.slice(1).map((l) => (levelGlyph(six, l.key) as { filled: number }).filled);
    expect(bars).toEqual([...bars].sort((x, y) => y - x));
    expect(Math.min(...bars)).toBeGreaterThanOrEqual(1);
    const two = [{ key: "p0", label: "P0" }, { key: "p1", label: "P1" }];
    expect(levelGlyph(two, "p0")).toEqual({ kind: "alert" });
    expect(levelGlyph(two, "p1")).toEqual({ kind: "bars", filled: 3 });
  });
  it("an unknown or retired key has no glyph and sorts last", () => {
    expect(levelGlyph(D, "p9")).toEqual({ kind: "none" });
    expect(levelRank(D, "p9")).toBe(D.length);
    expect(levelRank(D, "high")).toBe(1);
    expect(levelLabel(D, "p9")).toBe("p9");
  });
  it("falls back to the defaults", () => {
    expect(levelsOrDefault(undefined)).toBe(D);
    expect(levelsOrDefault([{ key: "x", label: "X" }])).toBe(D);
  });
});
