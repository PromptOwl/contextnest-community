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

  it("counts setext headings (=== / ---) so ids stay in sync with the viewer", () => {
    const md = "Title One\n=====\n\ntext\n\nTitle Two\n-----\n\n# Atx Three";
    expect(extractHeadings(md)).toEqual([
      { level: 1, text: "Title One", id: "doc-h-0" },
      { level: 2, text: "Title Two", id: "doc-h-1" },
      { level: 1, text: "Atx Three", id: "doc-h-2" },
    ]);
  });

  it("does not treat a thematic break (--- after a blank line) as setext", () => {
    const md = "# Real\n\n---\n\n## Also real";
    expect(extractHeadings(md).map((h) => h.text)).toEqual(["Real", "Also real"]);
  });

  it("counts blockquote-prefixed ATX headings", () => {
    const md = "> # Quoted\n\n## Plain";
    expect(extractHeadings(md)).toEqual([
      { level: 1, text: "Quoted", id: "doc-h-0" },
      { level: 2, text: "Plain", id: "doc-h-1" },
    ]);
  });

  it("returns empty for no headings / empty input", () => {
    expect(extractHeadings("plain text")).toEqual([]);
    expect(extractHeadings("")).toEqual([]);
  });
});
