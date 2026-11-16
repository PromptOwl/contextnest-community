import { describe, it, expect } from "vitest";
import { matchNests } from "./nest-search";

const nests = [
  { id: "nest_a", name: "Team Knowledge", description: "Engineering docs" },
  { id: "nest_b", name: "Sales Playbook", description: null },
  { id: "nest_c", name: "Archive" },
];

describe("matchNests", () => {
  it("matches on name, case-insensitively", () => {
    expect(matchNests(nests, "team").map((n) => n.id)).toEqual(["nest_a"]);
    expect(matchNests(nests, "SALES").map((n) => n.id)).toEqual(["nest_b"]);
  });

  it("matches on description and id too", () => {
    expect(matchNests(nests, "engineering").map((n) => n.id)).toEqual(["nest_a"]);
    expect(matchNests(nests, "nest_c").map((n) => n.id)).toEqual(["nest_c"]);
  });

  it("ignores accents", () => {
    expect(matchNests([{ id: "n", name: "Équipe Café" }], "equipe cafe").map((n) => n.title))
      .toEqual(["Équipe Café"]);
  });

  it("requires every term to match", () => {
    expect(matchNests(nests, "team knowledge").map((n) => n.id)).toEqual(["nest_a"]);
    expect(matchNests(nests, "team sales")).toEqual([]);
  });

  it("returns nothing for an empty query rather than everything", () => {
    expect(matchNests(nests, "   ")).toEqual([]);
  });

  it("falls back to the id when a nest has no name", () => {
    expect(matchNests([{ id: "nest_x" }], "nest_x")[0].title).toBe("nest_x");
  });
});

// Pins order the palette's nest rows the same way they order the dashboard —
// but only among things that already matched (CU-wdqcq00d63).
describe("matchNests — pinned ordering", () => {
  const withPins = [
    { id: "nest_a", name: "Team Knowledge" },
    { id: "nest_b", name: "Team Playbook", pinned: true },
    { id: "nest_c", name: "Team Archive" },
  ];

  it("floats pinned matches above unpinned ones", () => {
    expect(matchNests(withPins, "team").map((n) => n.id)).toEqual([
      "nest_b",
      "nest_a",
      "nest_c",
    ]);
  });

  it("never promotes a pinned nest that did not match", () => {
    expect(matchNests(withPins, "archive").map((n) => n.id)).toEqual(["nest_c"]);
  });

  it("leaves order alone when nothing is pinned", () => {
    expect(matchNests(nests, "e").map((n) => n.id)).toEqual([
      "nest_a",
      "nest_b",
      "nest_c",
    ]);
  });
});
