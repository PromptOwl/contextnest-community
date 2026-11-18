import { describe, it, expect } from "vitest";
import { detectTrigger, matchAgents, matchMembers, isMemberName } from "./picker-match";

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

describe("ambiguous names", () => {
  const johns = [{ email: "john@acme.com" }, { email: "john@other.com" }];

  it("treats a local part two people share as unresolved", () => {
    expect(isMemberName(johns, "john")).toBe(false);
    expect(isMemberName(johns, "john@acme.com")).toBe(true);
  });

  it("still offers both in the picker, where the writer chooses", () => {
    expect(matchMembers(johns, "john")).toHaveLength(2);
  });
});

describe("AC-UX-07 agent handles in the @ picker", () => {
  const agents = [
    { handle: "grok", wakeable: true },
    { handle: "scout", wakeable: false },
    { handle: "grok-v2", wakeable: false },
  ];

  it("lists every agent for a bare @, and narrows by what is typed", () => {
    expect(matchAgents(agents, "").map((a) => a.handle)).toEqual(["grok", "scout", "grok-v2"]);
    expect(matchAgents(agents, "GR").map((a) => a.handle)).toEqual(["grok", "grok-v2"]);
    expect(matchAgents(agents, "nobody")).toEqual([]);
  });

  it("keeps whether a mention wakes the agent, so the list can say so", () => {
    expect(matchAgents(agents, "scout")).toEqual([{ handle: "scout", wakeable: false }]);
  });

  it("caps the list", () => {
    expect(matchAgents(agents, "", 2)).toHaveLength(2);
  });
});
