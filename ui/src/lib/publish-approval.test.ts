import { describe, it, expect } from "vitest";
import { publishApproval } from "./publish-approval";

describe("publishApproval", () => {
  it("blocks a document that has never been approved", () => {
    expect(publishApproval({ approved: null, current: 3 })).toEqual({
      blocked: true,
      behindDraft: false,
    });
  });

  it("allows an approved document and says nothing extra when it is current", () => {
    expect(publishApproval({ approved: 4, current: 4 })).toEqual({
      blocked: false,
      behindDraft: false,
    });
  });

  it("flags newer unapproved edits above the approved version", () => {
    expect(publishApproval({ approved: 2, current: 5 })).toEqual({
      blocked: false,
      behindDraft: true,
    });
  });

  it("blocks nothing while the version list is unknown", () => {
    expect(publishApproval(null)).toEqual({ blocked: false, behindDraft: false });
  });
});
