import { describe, it, expect } from "vitest";
import * as core from "../src/lib/core/index.js";

/**
 * Surface guard for @promptowl/contextnest-community/core.
 *
 * Sister apps (e.g. PromptOwl TheOwl) consume this subpath. Removing or
 * renaming a member here is a breaking change for downstream consumers.
 * Update this list deliberately, never silently.
 */
const EXPECTED_EXPORTS = [
  // roles
  "collabPermToRole",
  "canViewWith",
  "canEditWith",
  "canApproveWith",
  "canManageWith",
  "primaryRole",
  // slug
  "toSlug",
  // lifecycle
  "canTransition",
  // string-utils
  "escapeRegex",
  "stripHtmlTagsSafe",
  // markdown
  "nodeToMarkdown",
  "nodesToMarkdown",
  // markdown-parser
  "extractTags",
  "extractWikiLinks",
  "extractMentions",
  "extractHyperlinks",
  "extractTasks",
  "parseMarkdownDocument",
  "renderWikiLink",
  "renderMention",
  "renderTag",
];

describe("@promptowl/contextnest-community/core surface", () => {
  it("exports every documented member", () => {
    const actual = new Set(Object.keys(core));
    const missing = EXPECTED_EXPORTS.filter((name) => !actual.has(name));
    expect(missing).toEqual([]);
  });

  it("role predicates behave per documented capability rules", () => {
    expect(core.canEditWith(["editor"])).toBe(true);
    expect(core.canEditWith(["viewer"])).toBe(false);
    expect(core.canApproveWith(["reviewer"])).toBe(true);
    expect(core.canApproveWith(["editor"])).toBe(false);
    expect(core.canManageWith(["admin"])).toBe(true);
    expect(core.canManageWith(["editor"])).toBe(false);
    expect(core.canViewWith([])).toBe(false);
    expect(core.canViewWith(["viewer"])).toBe(true);
    expect(core.primaryRole(["viewer", "owner", "editor"])).toBe("owner");
  });

  it("toSlug derives URL-safe slugs", () => {
    expect(core.toSlug("Hello World")).toBe("hello-world");
    expect(core.toSlug("  Trim & Special!! Chars  ")).toBe("trim-special-chars");
    expect(core.toSlug("---leading-trailing---")).toBe("leading-trailing");
  });

  it("canTransition enforces lifecycle rules", () => {
    expect(core.canTransition("draft", "pending_review")).toBe(true);
    expect(core.canTransition("pending_review", "approved")).toBe(true);
    expect(core.canTransition("approved", "published")).toBe(true);
    expect(core.canTransition("draft", "approved")).toBe(false);
    expect(core.canTransition("rejected", "approved")).toBe(false);
  });

  it("nodeToMarkdown produces the canonical LLM-export shape", () => {
    const md = core.nodeToMarkdown({
      id: "node-1",
      title: "Hello",
      tags: ["a", "b"],
      status: "draft",
      body: "Body text",
    });
    expect(md).toContain('title: "Hello"');
    expect(md).toContain('tags: ["a", "b"]');
    expect(md).toContain('status: "draft"');
    expect(md).toContain('id: "node-1"');
    expect(md.endsWith("Body text")).toBe(true);
  });

  it("parseMarkdownDocument extracts tags, mentions, wiki links, tasks", () => {
    const parsed = core.parseMarkdownDocument(
      "Hello #world @alice [[home]] - [ ] todo @bob",
    );
    expect(parsed.tags).toContain("world");
    expect(parsed.mentions.map((m) => m.name).sort()).toEqual(["alice", "bob"]);
    expect(parsed.wikiLinks[0]?.text).toBe("home");
    expect(parsed.tasks[0]?.completed).toBe(false);
  });
});
