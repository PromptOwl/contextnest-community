import { describe, it, expect } from "vitest";
import { nextFocusIndex, tabStopIndex } from "./roving-focus";

describe("nextFocusIndex @unit", () => {
  it("steps forward and back, wrapping at both ends", () => {
    expect(nextFocusIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextFocusIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextFocusIndex("ArrowLeft", 2, 3)).toBe(1);
    // The wrap that a plain `current - 1` would turn into -1, focusing nothing.
    expect(nextFocusIndex("ArrowLeft", 0, 3)).toBe(0 + 2);
  });

  it("treats the vertical arrows as the horizontal ones — the strip wraps", () => {
    expect(nextFocusIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextFocusIndex("ArrowUp", 0, 3)).toBe(2);
  });

  it("jumps to the ends", () => {
    expect(nextFocusIndex("Home", 2, 3)).toBe(0);
    expect(nextFocusIndex("End", 0, 3)).toBe(2);
  });

  it("returns null for keys it doesn't own, so the editor still sees them", () => {
    expect(nextFocusIndex("Tab", 0, 3)).toBeNull();
    expect(nextFocusIndex("a", 0, 3)).toBeNull();
  });

  it("returns null when focus is outside the group or the group is empty", () => {
    // -1 is what indexOf gives for an element that isn't in the list; acting
    // on it would yank focus into the toolbar from wherever the user was.
    expect(nextFocusIndex("ArrowRight", -1, 3)).toBeNull();
    expect(nextFocusIndex("ArrowRight", 0, 0)).toBeNull();
    expect(nextFocusIndex("ArrowRight", 5, 3)).toBeNull();
  });
});

describe("tabStopIndex @unit", () => {
  it("keeps the tab stop on the focused item, so Tab away and back returns", () => {
    expect(tabStopIndex(2, 0)).toBe(2);
  });

  it("otherwise offers the selected item — a segmented control's current value", () => {
    expect(tabStopIndex(-1, 3)).toBe(3);
  });

  it("falls back to the first item, so the group is never unreachable", () => {
    expect(tabStopIndex(-1, -1)).toBe(0);
  });
});
