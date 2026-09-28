import { describe, it, expect } from "vitest";
import { filterAndSortArchivedNests } from "./archived-nests";

const nests = [
  { name: "Zeta", archived_at: "2026-01-01T00:00:00Z" },
  { name: "alpha", archived_at: "2026-03-01T00:00:00Z" },
  { name: "Beta Plan", archived_at: "2026-02-01T00:00:00Z" },
];

describe("filterAndSortArchivedNests", () => {
  it("matches the name case-insensitively", () => {
    expect(filterAndSortArchivedNests(nests, "BETA", "name").map((n) => n.name)).toEqual([
      "Beta Plan",
    ]);
  });

  it("returns everything for a blank query", () => {
    expect(filterAndSortArchivedNests(nests, "  ", "name")).toHaveLength(3);
  });

  it("sorts by archive date, most recent first, by default", () => {
    expect(filterAndSortArchivedNests(nests, "", "archived").map((n) => n.name)).toEqual([
      "alpha",
      "Beta Plan",
      "Zeta",
    ]);
  });

  it("sorts by name A–Z, case-insensitively", () => {
    expect(filterAndSortArchivedNests(nests, "", "name").map((n) => n.name)).toEqual([
      "alpha",
      "Beta Plan",
      "Zeta",
    ]);
  });

  it("does not mutate the input array", () => {
    const copy = [...nests];
    filterAndSortArchivedNests(nests, "", "archived");
    expect(nests).toEqual(copy);
  });
});
