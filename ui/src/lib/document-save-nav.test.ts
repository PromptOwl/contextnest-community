import { describe, it, expect } from "vitest";
import { saveDestination } from "./document-save-nav";

describe("saveDestination", () => {
  it("returns to the nest when a brand-new document is created", () => {
    expect(saveDestination("new")).toBe("nest");
    expect(saveDestination("new", { publishedDraft: true, hasReturnTo: true })).toBe("nest");
  });

  it("stays in the editor when an existing document is saved", () => {
    expect(saveDestination("nodes/some-doc")).toBe("stay");
    expect(saveDestination("abc-123", { hasReturnTo: true })).toBe("stay");
  });

  it("publishing a draft goes back to where it was opened from (the Board)", () => {
    expect(saveDestination("nodes/task", { publishedDraft: true, hasReturnTo: true })).toBe("return");
  });

  it("publishing a draft with nowhere to return to stays", () => {
    expect(saveDestination("nodes/task", { publishedDraft: true })).toBe("stay");
  });
});
