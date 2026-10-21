import { describe, it, expect } from "vitest";
import {
  splitFrontmatter,
  joinFrontmatter,
  sourceLabel,
  baseRevisionOf,
  isStaleSaveError,
} from "./instructions";

// The Instructions tab (CU-wdqcq05mty): the nest's CONTEXT.md, which every
// agent reads first, edited by owners with a history.

describe("frontmatter", () => {
  const raw = '---\ntitle: "Glossary"\n---\n\n# Glossary\n\nRules.\n';

  it("edits the body and keeps the frontmatter block as it was", () => {
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toBe('---\ntitle: "Glossary"\n---\n');
    expect(body).toBe("# Glossary\n\nRules.\n");
    expect(joinFrontmatter(frontmatter, body)).toBe(raw);
  });

  it("round-trips an edited body", () => {
    const { frontmatter } = splitFrontmatter(raw);
    expect(joinFrontmatter(frontmatter, "# Glossary\n\nNew rule.\n")).toBe(
      '---\ntitle: "Glossary"\n---\n\n# Glossary\n\nNew rule.\n',
    );
  });

  it("leaves a file without frontmatter alone", () => {
    expect(splitFrontmatter("# Just a body\n")).toEqual({ frontmatter: "", body: "# Just a body\n" });
    expect(joinFrontmatter("", "# Just a body\n")).toBe("# Just a body\n");
  });
});

describe("history", () => {
  it("names where each change came from", () => {
    expect(sourceLabel("push")).toBe("ctx push");
    expect(sourceLabel("mcp")).toBe("Agent (MCP)");
    expect(sourceLabel("initial")).toBe("Before history was kept");
  });

  it("saves against the revision on screen, 0 before any is recorded", () => {
    expect(baseRevisionOf(null)).toBe(0);
    expect(
      baseRevisionOf({ seq: 4, authorEmail: null, note: null, source: "ui", createdAt: "" }),
    ).toBe(4);
  });

  it("recognises a stale save", () => {
    expect(isStaleSaveError({ status: 409 })).toBe(true);
    expect(isStaleSaveError({ status: 403 })).toBe(false);
    expect(isStaleSaveError(null)).toBe(false);
  });
});
