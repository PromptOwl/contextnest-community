import { describe, it, expect } from "vitest";
import { linkHealth } from "../ui/src/lib/link-health";

describe("linkHealth", () => {
  const nodes = [
    { id: "nodes/hub", title: "Hub", content: "[[nodes/leaf|Leaf]] and [[Missing Doc]]" },
    { id: "nodes/leaf", title: "Leaf", content: "back to [[Hub]]" },
    { id: "nodes/island", title: "Island", content: "no links at all" },
  ];

  it("finds broken links with their source", () => {
    const { broken } = linkHealth(nodes);
    expect(broken).toEqual([
      { sourceId: "nodes/hub", sourceTitle: "Hub", target: "Missing Doc" },
    ]);
  });

  it("finds orphans (nothing links to them)", () => {
    const { orphans } = linkHealth(nodes);
    expect(orphans.map((o) => o.id)).toEqual(["nodes/island"]);
  });

  it("self-links don't rescue a doc from orphanhood", () => {
    const { orphans } = linkHealth([
      { id: "nodes/self", title: "Self", content: "[[Self]]" },
    ]);
    expect(orphans.map((o) => o.id)).toEqual(["nodes/self"]);
  });

  it("empty input → empty report", () => {
    expect(linkHealth([])).toEqual({ orphans: [], broken: [] });
  });

  it("a nest with no wiki links anywhere reports no orphans", () => {
    const linkless = [
      { id: "nodes/a", title: "A", content: "# A\n\nprose only" },
      { id: "nodes/b", title: "B", content: "# B\n\nmore prose" },
    ];
    expect(linkHealth(linkless)).toEqual({ orphans: [], broken: [] });
  });
});
