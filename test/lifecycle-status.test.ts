import { describe, it, expect } from "vitest";
import { lifecycleStatusHint } from "../ui/src/lib/lifecycle-status";

describe("lifecycleStatusHint", () => {
  it("names the submitter of a pending review", () => {
    const hint = lifecycleStatusHint("pending_review", { submittedBy: "ana@example.com" });
    expect(hint).toContain("Submitted for review by ana@example.com");
    expect(hint).toContain("steward");
  });

  it("omits the submitter when unknown", () => {
    expect(lifecycleStatusHint("pending_review", { submittedBy: null })).toMatch(
      /^Submitted for review — /,
    );
  });

  it("points a draft at Submit only when the nest has stewardship", () => {
    expect(lifecycleStatusHint("draft", { stewardship: true })).toContain("Submit for review");
    expect(lifecycleStatusHint("draft", { stewardship: false })).not.toContain("Submit");
  });

  it("explains every badge status and nothing else", () => {
    for (const s of ["draft", "pending_review", "approved", "published", "rejected", "external_edit_pending"]) {
      expect(lifecycleStatusHint(s)).not.toBe("");
    }
    expect(lifecycleStatusHint("forgotten")).toBe("");
  });
});
