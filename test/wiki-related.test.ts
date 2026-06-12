import { describe, it, expect } from "vitest";
import { relatedDocs } from "../ui/src/lib/related";

const target = {
  id: "nodes/a",
  title: "A",
  tags: ["#api", "#design"],
  content: "see [[nodes/x]] and [[nodes/y]]",
};

describe("relatedDocs", () => {
  it("scores shared tags higher than shared links and sorts by score", () => {
    const nodes = [
      target,
      { id: "nodes/b", title: "B", tags: ["#api", "#design"], content: "" }, // 2 tags = 4
      { id: "nodes/c", title: "C", tags: ["#api"], content: "[[nodes/x]]" }, // 1 tag + 1 link = 3
      { id: "nodes/d", title: "D", tags: [], content: "[[nodes/x]] [[nodes/y]]" }, // 2 links = 2
    ];
    const r = relatedDocs(target, nodes);
    expect(r.map((x) => x.id)).toEqual(["nodes/b", "nodes/c", "nodes/d"]);
    expect(r[0].score).toBe(4);
    expect(r[0].sharedTags).toEqual(["#api", "#design"]);
  });

  it("excludes the target itself and zero-overlap docs", () => {
    const nodes = [
      target,
      { id: "nodes/z", title: "Z", tags: ["#unrelated"], content: "" },
    ];
    expect(relatedDocs(target, nodes)).toEqual([]);
  });

  it("honors the limit and breaks ties by title", () => {
    const nodes = [
      target,
      { id: "nodes/c", title: "Cee", tags: ["#api"], content: "" },
      { id: "nodes/b", title: "Bee", tags: ["#api"], content: "" },
    ];
    const r = relatedDocs(target, nodes, 1);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe("Bee");
  });
});
