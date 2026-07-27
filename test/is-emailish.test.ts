import { describe, it, expect } from "vitest";
import { isEmailish } from "../ui/src/lib/utils";

describe("isEmailish (collaborator/steward/team email validation)", () => {
  it("accepts normal addresses", () => {
    for (const e of [
      "user@gmail.com",
      "first.last+tag@sub.example.co.uk",
      "a_b-c.d@x-y.io",
      "  spaced@trim.me  ", // trimmed before validating
    ]) {
      expect(isEmailish(e)).toBe(true);
    }
  });

  it("rejects malformed / special-char input", () => {
    for (const e of [
      "*'/*'/*--------/*'8/////@gmail.com", // the reported QA case
      "a b@x.com",
      "noat",
      "foo@bar", // no TLD
      "foo@@bar.com",
      "@gmail.com",
      "",
    ]) {
      expect(isEmailish(e)).toBe(false);
    }
  });
});
