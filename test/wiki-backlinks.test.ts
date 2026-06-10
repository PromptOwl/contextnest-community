import { describe, it, expect } from "vitest";
import {
  extractWikiLinkTargets,
  findBacklinks,
} from "../ui/src/lib/backlinks";

describe("extractWikiLinkTargets", () => {
  it("extracts bare and aliased targets", () => {
    expect(
      extractWikiLinkTargets("see [[nodes/foo|Foo]] and [[Bar Doc]] end"),
    ).toEqual(["nodes/foo", "Bar Doc"]);
  });

  it("returns empty for no links / empty content", () => {
    expect(extractWikiLinkTargets("plain text")).toEqual([]);
    expect(extractWikiLinkTargets("")).toEqual([]);
  });
});

describe("findBacklinks", () => {
  const nodes = [
    { id: "nodes/a", title: "Alpha", content: "links to [[nodes/target|T]]" },
    { id: "nodes/b", title: "Beta", content: "links by title [[Target Doc]]" },
    { id: "nodes/c", title: "Gamma", content: "links by slug [[target]]" },
    { id: "nodes/d", title: "Delta", content: "no links here" },
    { id: "nodes/target", title: "Target Doc", content: "[[target]] self" },
  ];
  const target = { id: "nodes/target", title: "Target Doc" };

  it("matches by id, title, and bare slug; excludes self and non-linkers", () => {
    const result = findBacklinks(nodes, target);
    expect(result.map((r) => r.id).sort()).toEqual([
      "nodes/a",
      "nodes/b",
      "nodes/c",
    ]);
  });

  it("is case-insensitive", () => {
    const result = findBacklinks(
      [{ id: "nodes/x", title: "X", content: "[[TARGET DOC]]" }],
      target,
    );
    expect(result).toHaveLength(1);
  });

  it("handles nodes without content", () => {
    expect(findBacklinks([{ id: "nodes/y", title: "Y" }], target)).toEqual([]);
  });
});
