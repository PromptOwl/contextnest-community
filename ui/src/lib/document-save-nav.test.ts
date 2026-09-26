import { describe, it, expect } from "vitest";
import { shouldReturnToNestOnSave } from "./document-save-nav";

describe("shouldReturnToNestOnSave", () => {
  it("returns to the nest when a brand-new document is created", () => {
    expect(shouldReturnToNestOnSave("new")).toBe(true);
  });

  it("stays in the editor when an existing document is saved", () => {
    expect(shouldReturnToNestOnSave("nodes/some-doc")).toBe(false);
    expect(shouldReturnToNestOnSave("abc-123")).toBe(false);
  });
});
