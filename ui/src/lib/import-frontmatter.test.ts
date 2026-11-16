import { describe, it, expect } from "vitest";
import { importedMarkdown } from "./import-frontmatter";

describe("importedMarkdown", () => {
  it("takes title and tags from the frontmatter and keeps only the body", () => {
    const raw = "---\ntitle: Frontmatter Title\ntags:\n  - alpha\n  - beta\n---\n\nBody text\n";
    expect(importedMarkdown(raw)).toEqual({ title: "Frontmatter Title", tags: ["alpha", "beta"], body: "Body text\n" });
  });

  it("reads CRLF files and comma-separated tags", () => {
    expect(importedMarkdown("---\r\ntitle: \"T\"\r\ntags: a, b\r\n---\r\nBody")).toEqual({ title: "T", tags: ["a", "b"], body: "Body" });
  });

  it("leaves a file without frontmatter untouched", () => {
    expect(importedMarkdown("# Heading\n\ntext")).toEqual({ body: "# Heading\n\ntext" });
  });

  it("leaves the file as it was when the YAML doesn't parse", () => {
    const raw = "---\ntitle: [unclosed\n---\nBody";
    expect(importedMarkdown(raw)).toEqual({ body: raw });
  });

  it("drops the block but keeps the file name title when no title is set", () => {
    expect(importedMarkdown("---\nauthor: me\n---\nBody")).toEqual({ body: "Body" });
  });
});
