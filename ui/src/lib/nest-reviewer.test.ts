import { describe, it, expect } from "vitest";
import { nestReviewerState } from "./nest-reviewer";

const row = (over: Partial<{ id: string; userEmail: string; role: string; scope: string }>) => ({
  id: "s1",
  userEmail: "rex@acme.com",
  role: "reviewer",
  scope: "nest",
  ...over,
});

describe("nestReviewerState (the Collaborators Reviewer switch)", () => {
  it("is on for a nest-scope reviewer row, matching email case-insensitively", () => {
    expect(nestReviewerState([row({ id: "s9" })], "Rex@Acme.com")).toEqual({ kind: "reviewer", stewardId: "s9" });
  });
  it("is off when the person has no nest-scope steward row", () => {
    expect(nestReviewerState([], "rex@acme.com")).toEqual({ kind: "none" });
    // Tag/document reviewers don't review the whole nest.
    expect(nestReviewerState([row({ scope: "tag" }), row({ scope: "document" })], "rex@acme.com")).toEqual({ kind: "none" });
    expect(nestReviewerState([row({ userEmail: "amy@acme.com" })], "rex@acme.com")).toEqual({ kind: "none" });
  });
  it("reports another nest-wide role so the switch can stay out of its way", () => {
    expect(nestReviewerState([row({ role: "editor" })], "rex@acme.com")).toEqual({ kind: "other", role: "editor" });
    // A reviewer row wins over a second, different nest row.
    expect(nestReviewerState([row({ id: "e", role: "editor" }), row({ id: "r" })], "rex@acme.com")).toEqual({
      kind: "reviewer",
      stewardId: "r",
    });
  });
});
