import { describe, it, expect } from "vitest";
import { selectionState, toggleMany } from "./bulk-select";

const a = { id: "a" };
const b = { id: "b" };
const c = { id: "c" };

describe("selectionState", () => {
  it("reports none, some and all", () => {
    expect(selectionState(new Map(), [a, b])).toBe(false);
    expect(selectionState(new Map([["a", a]]), [a, b])).toBe("indeterminate");
    expect(selectionState(new Map([["a", a], ["b", b]]), [a, b])).toBe(true);
    expect(selectionState(new Map(), [])).toBe(false);
  });
});

describe("toggleMany", () => {
  it("selects the whole group when any of it is unselected", () => {
    const next = toggleMany(new Map([["a", a]]), [a, b]);
    expect([...next.keys()].sort()).toEqual(["a", "b"]);
  });

  it("deselects only the group when it is fully selected", () => {
    const next = toggleMany(new Map([["a", a], ["b", b], ["c", c]]), [a, b]);
    expect([...next.keys()]).toEqual(["c"]);
  });

  it("does not mutate the input", () => {
    const start = new Map([["a", a]]);
    toggleMany(start, [a, b]);
    expect([...start.keys()]).toEqual(["a"]);
  });
});
