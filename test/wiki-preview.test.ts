import { describe, it, expect } from "vitest";
import {
  resolveWikiTarget,
  previewSnippet,
} from "../ui/src/lib/wiki-preview";

const nodes = [
  { id: "nodes/api-guide", title: "API Guide", content: "# API\n\nBody." },
  { id: "nodes/other", title: "Other Doc" },
];

describe("resolveWikiTarget", () => {
  it("resolves by id, title, and bare slug (case-insensitive)", () => {
    expect(resolveWikiTarget(nodes, "nodes/api-guide")?.id).toBe("nodes/api-guide");
    expect(resolveWikiTarget(nodes, "api guide")?.id).toBe("nodes/api-guide");
    expect(resolveWikiTarget(nodes, "API-GUIDE")?.id).toBe("nodes/api-guide");
  });

  it("returns null for no match / empty target", () => {
    expect(resolveWikiTarget(nodes, "missing")).toBeNull();
    expect(resolveWikiTarget(nodes, "  ")).toBeNull();
  });
});

describe("previewSnippet", () => {
  it("strips markdown to plain text", () => {
    expect(
      previewSnippet("# Title\n\nSome **bold** and [[nodes/x|X]] and [a](http://b)."),
    ).toBe("Title Some bold and X and a.");
  });

  it("truncates with ellipsis", () => {
    const s = previewSnippet("word ".repeat(100), 40);
    expect(s.length).toBeLessThanOrEqual(41);
    expect(s.endsWith("…")).toBe(true);
  });

  it("drops fenced code blocks", () => {
    expect(previewSnippet("before\n```\ncode here\n```\nafter")).toBe(
      "before after",
    );
  });
});
