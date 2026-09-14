/**
 * Dashboard's card-grid bin icon and NestView's overflow-menu "Delete" entry
 * share one rule for when a non-deleting caller may ASK for a nest to be
 * archived or deleted instead: editor, or a nest-admin collaborator who still
 * isn't the caller that can delete outright.
 */
import { describe, it, expect } from "vitest";
import { canRequestNestRemoval } from "./nest-caps";

describe("canRequestNestRemoval", () => {
  it("lets an editor request removal", () => {
    expect(canRequestNestRemoval("editor", false)).toBe(true);
  });

  it("lets a non-owner nest admin request removal", () => {
    expect(canRequestNestRemoval("admin", false)).toBe(true);
  });

  it("withholds it from a reviewer", () => {
    expect(canRequestNestRemoval("reviewer", false)).toBe(false);
  });

  it("withholds it from a viewer", () => {
    expect(canRequestNestRemoval("viewer", false)).toBe(false);
  });

  it("withholds it when there is no role at all", () => {
    expect(canRequestNestRemoval(null, false)).toBe(false);
  });

  it("withholds it once the caller can already delete outright", () => {
    // The owner (or admin caretaker) gets the real Delete button instead —
    // asking would be a request to themselves.
    expect(canRequestNestRemoval("admin", true)).toBe(false);
    expect(canRequestNestRemoval("editor", true)).toBe(false);
  });
});
