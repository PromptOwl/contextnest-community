import { describe, it, expect } from "vitest";
import { unlinkedMentions } from "../ui/src/lib/unlinked-mentions";

const target = { id: "nodes/api-guide", title: "API Guide" };

describe("unlinkedMentions", () => {
  it("finds docs mentioning the title in prose without a wiki link", () => {
    const nodes = [
      { id: "nodes/a", title: "A", content: "Read the API Guide for setup." },
      { id: "nodes/b", title: "B", content: "no mention here" },
    ];
    expect(unlinkedMentions(target, nodes)).toEqual([
      { id: "nodes/a", title: "A" },
    ]);
  });

  it("skips docs that already link the target (title, id, or slug form)", () => {
    const nodes = [
      { id: "nodes/a", title: "A", content: "See [[API Guide]] today." },
      { id: "nodes/b", title: "B", content: "See [[nodes/api-guide]] too." },
      { id: "nodes/c", title: "C", content: "See [[api-guide]] also." },
    ];
    expect(unlinkedMentions(target, nodes)).toEqual([]);
  });

  it("does not count a mention that only occurs inside a wiki link", () => {
    const nodes = [
      { id: "nodes/a", title: "A", content: "[[Other|API Guide]] alias only" },
    ];
    // The text "API Guide" appears, but solely as a link alias → no mention.
    expect(unlinkedMentions(target, nodes)).toEqual([]);
  });

  it("matches whole words only and ignores the target itself", () => {
    const nodes = [
      { id: "nodes/api-guide", title: "API Guide", content: "self API Guide" },
      { id: "nodes/x", title: "X", content: "API Guidebook is different" },
    ];
    expect(unlinkedMentions(target, nodes)).toEqual([]);
  });

  it("returns empty for a blank target title", () => {
    const nodes = [{ id: "nodes/a", title: "A", content: "anything" }];
    expect(unlinkedMentions({ id: "nodes/a2", title: "" }, nodes)).toEqual([]);
  });
});
