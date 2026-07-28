import { describe, it, expect } from "vitest";
import { splitExportedMarkdown } from "./markdown-split";

/** Mirror the server's markdown-export serialization so the tests exercise the
 *  exact shape the splitter must reverse (src/nodes/markdown-export.ts). */
function nodeToMarkdown(n: {
  id: string;
  title?: string;
  tags?: string[];
  status?: string;
  body?: string;
}): string {
  return (
    [
      "---",
      `title: ${JSON.stringify(n.title ?? "")}`,
      `tags: [${(n.tags ?? []).map((t) => JSON.stringify(t)).join(", ")}]`,
      `status: ${JSON.stringify(n.status ?? "")}`,
      `id: ${JSON.stringify(n.id)}`,
      "---",
      "",
    ].join("\n") + (n.body ?? "")
  );
}
const nodesToMarkdown = (ns: Parameters<typeof nodeToMarkdown>[0][]) =>
  ns.map(nodeToMarkdown).join("\n\n---\n\n");

describe("splitExportedMarkdown", () => {
  it("splits a whole-nest export into one file per document, path from id", () => {
    const text = nodesToMarkdown([
      { id: "nodes/alpha-doc", title: "Alpha", tags: ["x"], status: "published", body: "alpha body" },
      { id: "nodes/beta-doc", title: "Beta", tags: [], status: "published", body: "beta body" },
    ]);
    const out = splitExportedMarkdown(text, "export.md");
    expect(out.map((f) => f.path)).toEqual(["nodes/alpha-doc.md", "nodes/beta-doc.md"]);
    expect(out.every((f) => f.content.startsWith("---"))).toBe(true);
    expect(out[0].content).toContain("alpha body");
    expect(out[1].content).toContain("beta body");
  });

  it("keeps a horizontal rule inside a body instead of mis-splitting on it", () => {
    const text = nodesToMarkdown([
      { id: "a", title: "A", status: "published", body: "before\n\n---\n\nafter" },
      { id: "b", title: "B", status: "published", body: "b body" },
    ]);
    const out = splitExportedMarkdown(text, "export.md");
    // Still two docs — the in-body rule did not create a phantom third.
    expect(out.map((f) => f.path)).toEqual(["a.md", "b.md"]);
    expect(out[0].content).toContain("before\n\n---\n\nafter");
  });

  it("passes a normal single-doc markdown file through unchanged", () => {
    const single = "---\ntitle: Solo\n---\njust one doc";
    const out = splitExportedMarkdown(single, "solo.md");
    expect(out).toEqual([{ path: "solo.md", content: single }]);
  });

  it("passes plain markdown with no frontmatter through unchanged", () => {
    const plain = "# Heading\n\nno frontmatter here";
    const out = splitExportedMarkdown(plain, "notes.md");
    expect(out).toEqual([{ path: "notes.md", content: plain }]);
  });

  it("falls back to title then index, and de-dupes colliding paths", () => {
    const text = nodesToMarkdown([
      { id: "", title: "Same Name", status: "published", body: "one" },
      { id: "", title: "Same Name", status: "published", body: "two" },
    ]);
    const out = splitExportedMarkdown(text, "export.md");
    // id is empty → title drives the name; the collision is suffixed.
    expect(out.map((f) => f.path)).toEqual(["Same Name.md", "Same Name-2.md"]);
  });

  it("normalizes CRLF exports before splitting", () => {
    const text = nodesToMarkdown([
      { id: "a", title: "A", status: "published", body: "a body" },
      { id: "b", title: "B", status: "published", body: "b body" },
    ]).replace(/\n/g, "\r\n");
    const out = splitExportedMarkdown(text, "export.md");
    expect(out.map((f) => f.path)).toEqual(["a.md", "b.md"]);
  });
});
