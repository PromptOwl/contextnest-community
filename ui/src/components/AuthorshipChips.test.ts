import { describe, it, expect } from "vitest";
import { initialsOf } from "./AuthorshipChips";

describe("initialsOf", () => {
  it("takes the first two words of a display name", () => {
    expect(initialsOf("Taimur Ammer Admin")).toBe("TA");
  });

  it("takes two letters of a single-word name", () => {
    expect(initialsOf("taimur")).toBe("TA");
  });

  it("keeps the email form unchanged", () => {
    expect(initialsOf("promptowlseven@yahoo.com")).toBe("PR");
    expect(initialsOf("jane.doe@acme.com")).toBe("JD");
    expect(initialsOf("")).toBe("?");
  });
});
