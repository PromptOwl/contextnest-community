import { describe, it, expect } from "vitest";
import { extractHeadings } from "../ui/src/lib/toc";

describe("extractHeadings", () => {
  it("extracts h1-h3 in order with sequential ids", () => {
    const md = "# One\n\ntext\n\n## Two\n\n### Three\n\n#### Four (ignored)";
    expect(extractHeadings(md)).toEqual([
      { level: 1, text: "One", id: "doc-h-0" },
      { level: 2, text: "Two", id: "doc-h-1" },
      { level: 3, text: "Three", id: "doc-h-2" },
    ]);
  });

  it("skips headings inside fenced code blocks", () => {
    const md = "# Real\n\n```\n# not a heading\n```\n\n## Also real";
    expect(extractHeadings(md).map((h) => h.text)).toEqual([
      "Real",
      "Also real",
    ]);
  });

  it("strips inline markdown and wiki links from heading text", () => {
    const md = "# **Bold** and [link](http://x) and [[nodes/foo|Foo]]";
    expect(extractHeadings(md)[0].text).toBe("Bold and link and Foo");
  });

  it("returns empty for no headings / empty input", () => {
    expect(extractHeadings("plain text")).toEqual([]);
    expect(extractHeadings("")).toEqual([]);
  });
});
