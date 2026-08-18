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
