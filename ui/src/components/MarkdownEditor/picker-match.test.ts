import { describe, it, expect } from "vitest";
import { detectTrigger, matchMembers, isMemberName } from "./picker-match";

const members = [
  { email: "ada@example.com" },
  { email: "grace@example.com", name: "Grace Hopper" },
];

describe("detectTrigger", () => {
  it("matches an open wiki bracket at the caret", () => {
    expect(detectTrigger("see [[Onboard")).toEqual({
      kind: "wiki",
      query: "Onboard",
      length: 9,
    });
  });

  it("stops matching once the wiki link is closed", () => {
    expect(detectTrigger("see [[Onboarding]]")).toBeNull();
  });

  it("matches @ at a word boundary, excluding the leading space", () => {
    expect(detectTrigger("ping @ada")).toEqual({
      kind: "mention",
      query: "ada",
      length: 4,
    });
    expect(detectTrigger("@")).toEqual({
      kind: "mention",
      query: "",
      length: 1,
    });
  });

  it("keeps matching through an email so a typed address stays pickable", () => {
    expect(detectTrigger("ping @ada@example.com")?.query).toBe(
      "ada@example.com",
    );
  });

  it("ignores an @ mid-word and a finished mention", () => {
    expect(detectTrigger("read the file@")).toBeNull();
    expect(detectTrigger("ping @ada ")).toBeNull();
  });
});

describe("matchMembers", () => {
  it("lists everyone for an empty query", () => {
    expect(matchMembers(members, "")).toHaveLength(2);
  });

  it("matches on email, local part and display name", () => {
    expect(matchMembers(members, "grace")).toEqual([members[1]]);
    expect(matchMembers(members, "Hopper")).toEqual([members[1]]);
    expect(matchMembers(members, "example.com")).toHaveLength(2);
    expect(matchMembers(members, "nobody")).toEqual([]);
  });
});

describe("isMemberName", () => {
  it("resolves full email, local part and name", () => {
    expect(isMemberName(members, "ada@example.com")).toBe(true);
    expect(isMemberName(members, "ada")).toBe(true);
    expect(isMemberName(members, "Grace Hopper")).toBe(true);
  });

  it("rejects a name nobody on the nest carries", () => {
    expect(isMemberName(members, "Editor")).toBe(false);
    expect(isMemberName(members, "")).toBe(false);
  });
});
