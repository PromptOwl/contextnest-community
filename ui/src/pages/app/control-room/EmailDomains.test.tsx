import { describe, it, expect } from "vitest";
import { parseDomains } from "./EmailDomains";

describe("parseDomains", () => {
  it("splits on commas and spaces, drops a leading @, lowercases and dedupes", () => {
    expect(parseDomains(" @Acme.com, acme.co.uk acme.com ")).toEqual(["acme.com", "acme.co.uk"]);
    expect(parseDomains("  ")).toEqual([]);
  });
});
