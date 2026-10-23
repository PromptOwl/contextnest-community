import { describe, it, expect } from "vitest";
import { saveOutcome } from "./save-outcome";

const base = {
  isNew: false,
  isOwnPendingReview: false,
  stewardshipEnabled: true,
  prime: false,
  primeOnlyReview: false,
  creatorIsReviewer: false,
  allowSelfApprove: false,
  ownerOrAdmin: false,
};

describe("saveOutcome mirrors the server's publish gate", () => {
  it("publishes when stewardship is off", () => {
    expect(saveOutcome({ ...base, stewardshipEnabled: false })).toBe("publish");
  });

  it("drafts a prime document past every bypass", () => {
    expect(
      saveOutcome({
        ...base,
        prime: true,
        isNew: true,
        creatorIsReviewer: true,
        primeOnlyReview: true,
        allowSelfApprove: true,
        ownerOrAdmin: true,
      }),
    ).toBe("draft");
  });

  it("publishes a non-prime document in a prime-only nest", () => {
    expect(saveOutcome({ ...base, primeOnlyReview: true })).toBe("publish");
  });

  it("publishes v1 when the creator reviews, but not a later edit", () => {
    expect(saveOutcome({ ...base, isNew: true, creatorIsReviewer: true })).toBe("publish");
    expect(saveOutcome({ ...base, creatorIsReviewer: true })).toBe("draft");
  });

  it("publishes for an owner/admin with self-approve, drafts for everyone else", () => {
    expect(saveOutcome({ ...base, allowSelfApprove: true, ownerOrAdmin: true })).toBe("publish");
    expect(saveOutcome({ ...base, allowSelfApprove: true })).toBe("draft");
    expect(saveOutcome({ ...base, ownerOrAdmin: true })).toBe("draft");
  });

  it("is pending while the author revises their own submission", () => {
    expect(saveOutcome({ ...base, isOwnPendingReview: true, stewardshipEnabled: false })).toBe("pending");
  });
});
