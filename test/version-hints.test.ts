import { describe, it, expect } from "vitest";
import { NEVER_PUBLISHED_HINT } from "../ui/src/components/governance/version-hints";

describe("NEVER_PUBLISHED_HINT", () => {
  it("keeps the status and the next-step guidance as two separate sentences", () => {
    expect(NEVER_PUBLISHED_HINT.status).toBe(
      "Never published — no approved version exists yet.",
    );
    expect(NEVER_PUBLISHED_HINT.guidance).toBe(
      "Saving keeps this document a draft; Submit for review to publish it.",
    );
  });

  it("does not let either sentence swallow the other", () => {
    // A regression that re-merges them into one run-on sentence would make
    // one of these fail.
    expect(NEVER_PUBLISHED_HINT.status).not.toContain("Saving keeps");
    expect(NEVER_PUBLISHED_HINT.guidance).not.toContain("Never published");
  });
});
