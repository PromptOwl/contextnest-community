/**
 * Approve / Reject on an archive request (My Work) must look like Approve /
 * Reject on a review item — one pair, shared by both surfaces
 * (CU-wdqcq027gw). Guards the pair itself: approve reads green, reject
 * reads red, both are outline buttons with a coloured border.
 */
import { describe, it, expect } from "vitest";
import { APPROVE_BUTTON_CLASS, REJECT_BUTTON_CLASS } from "./review-actions-style";

describe("review action button styles", () => {
  it("approve is green, reject is red", () => {
    expect(APPROVE_BUTTON_CLASS).toMatch(/text-green-/);
    expect(APPROVE_BUTTON_CLASS).not.toMatch(/red/);
    expect(REJECT_BUTTON_CLASS).toMatch(/text-red-/);
    expect(REJECT_BUTTON_CLASS).not.toMatch(/green/);
  });

  it("both carry a coloured border for the outline variant", () => {
    expect(APPROVE_BUTTON_CLASS).toMatch(/border-green-/);
    expect(REJECT_BUTTON_CLASS).toMatch(/border-red-/);
  });
});
