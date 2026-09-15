/**
 * Public docs reader — the pure navigation logic: how a wikilink target is
 * resolved, how a node id becomes a breadcrumb, and what "previous / next"
 * mean in a folder-ordered nest.
 */
import { describe, it, expect } from "vitest";
import { resolveWikiTarget, breadcrumbFor, sectionLabel, readingOrder, neighbours, stripLeadingTitle, commonRootFolder, displayTitle, orderWithinFolder, ancestorsOf } from "./reader";

const nodes = [
  { id: "nodes/docs/welcome", title: "Welcome" },
  { id: "nodes/docs/protocol/concepts/overview", title: "Overview" },
  { id: "nodes/docs/protocol/concepts/frontmatter", title: "Frontmatter" },
  { id: "nodes/docs/protocol/selectors/overview", title: "Overview" },
  { id: "nodes/docs/protocol/selectors/atoms", title: "Atoms" },
  { id: "nodes/docs/platform/hosted-nest/hosted-nest", title: "Hosted Nest" },
];

describe("resolveWikiTarget", () => {
  it("resolves by path before title, so the twelfth 'Overview' is not a coin toss", () => {
    expect(resolveWikiTarget("docs/protocol/selectors/overview", nodes)?.id).toBe("nodes/docs/protocol/selectors/overview");
    expect(resolveWikiTarget("nodes/docs/protocol/concepts/overview", nodes)?.id).toBe("nodes/docs/protocol/concepts/overview");
  });
  it("tolerates a trailing .md and a leading slash", () => {
    expect(resolveWikiTarget("/docs/protocol/selectors/atoms.md", nodes)?.id).toBe("nodes/docs/protocol/selectors/atoms");
  });
  it("falls back to a case-insensitive title match when the path does not exist", () => {
    expect(resolveWikiTarget("hosted nest", nodes)?.id).toBe("nodes/docs/platform/hosted-nest/hosted-nest");
    expect(resolveWikiTarget("docs/platform/hosted-nest/overview", nodes)).toBeNull(); // a wrong path is NOT silently rewritten to some 'Overview'
  });
  it("a slash-less target also matches a page slug when no title does", () => {
    expect(resolveWikiTarget("atoms", nodes)?.id).toBe("nodes/docs/protocol/selectors/atoms");
    expect(resolveWikiTarget("frontmatter", nodes)?.id).toBe("nodes/docs/protocol/concepts/frontmatter"); // title wins, same answer
  });
  it("returns null when nothing matches", () => {
    expect(resolveWikiTarget("nope", nodes)).toBeNull();
  });
});

describe("breadcrumbFor / sectionLabel", () => {
  it("turns the folder path into readable crumbs and leaves the leaf off", () => {
    expect(breadcrumbFor("nodes/docs/protocol/source-nodes/writing-source-nodes")).toEqual(["Docs", "Protocol", "Source nodes"]);
    expect(breadcrumbFor("nodes/docs/welcome")).toEqual(["Docs"]);
    expect(breadcrumbFor("nodes/readme")).toEqual([]);
  });
  it("labels a folder from its slug", () => {
    expect(sectionLabel("docs/platform/hosted-nest")).toBe("Hosted nest");
    expect(sectionLabel("Root")).toBe("General");
  });
});

describe("readingOrder / neighbours", () => {
  const groups = [
    { folder: "docs", items: [{ id: "nodes/docs/welcome", title: "Welcome" }] },
    { folder: "docs/protocol/concepts", items: [{ id: "nodes/docs/protocol/concepts/overview", title: "Overview" }, { id: "nodes/docs/protocol/concepts/frontmatter", title: "Frontmatter" }] },
    { folder: "docs/protocol/selectors", items: [{ id: "nodes/docs/protocol/selectors/overview", title: "Overview" }, { id: "nodes/docs/protocol/selectors/atoms", title: "Atoms" }] },
  ];
  it("flattens groups in order, an 'overview' first within its folder", () => {
    expect(readingOrder(groups).map((n) => n.id)).toEqual([
      "nodes/docs/welcome",
      "nodes/docs/protocol/concepts/overview",
      "nodes/docs/protocol/concepts/frontmatter",
      "nodes/docs/protocol/selectors/overview",
      "nodes/docs/protocol/selectors/atoms",
    ]);
  });
  it("gives previous and next, with none at the ends", () => {
    const order = readingOrder(groups);
    expect(neighbours(order, "nodes/docs/protocol/concepts/frontmatter")).toEqual({
      prev: expect.objectContaining({ id: "nodes/docs/protocol/concepts/overview" }),
      next: expect.objectContaining({ id: "nodes/docs/protocol/selectors/overview" }),
    });
    expect(neighbours(order, "nodes/docs/welcome").prev).toBeNull();
    expect(neighbours(order, "nodes/docs/protocol/selectors/atoms").next).toBeNull();
    expect(neighbours(order, "nodes/missing")).toEqual({ prev: null, next: null });
  });
});

describe("stripLeadingTitle", () => {
  it("drops a leading H1 that repeats the page title, and nothing else", () => {
    expect(stripLeadingTitle("# Self-Hosting (Community Edition)\n\nBody", "Self-Hosting (Community Edition)")).toBe("\nBody");
    expect(stripLeadingTitle("# Other\n\nBody", "Title")).toBe("# Other\n\nBody");
    expect(stripLeadingTitle("Intro\n# Title", "Title")).toBe("Intro\n# Title");
    expect(stripLeadingTitle("# **Title**\nx", "Title")).toBe("x");
  });
});

describe("commonRootFolder", () => {
  it("names the single top-level folder every group sits under, else empty", () => {
    expect(commonRootFolder([{ folder: "docs" }, { folder: "docs/protocol" }], [{ path: "docs/platform" }])).toBe("docs");
    expect(commonRootFolder([{ folder: "docs" }, { folder: "guides" }])).toBe("");
    expect(commonRootFolder([{ folder: "Root" }, { folder: "docs" }])).toBe("");
  });
});

describe("displayTitle", () => {
  it("uses the body H1 only when the node title is a generic lead name", () => {
    expect(displayTitle({ id: "nodes/docs/protocol/selectors/overview", title: "Overview" }, "# Selectors\n\nx")).toBe("Selectors");
    expect(displayTitle({ id: "nodes/docs/welcome", title: "Welcome" }, "# PromptOwl Documentation\n")).toBe("PromptOwl Documentation");
    expect(displayTitle({ id: "nodes/docs/x", title: "Self-Hosting" }, "# Something else\n")).toBe("Self-Hosting");
    expect(displayTitle({ id: "nodes/docs/overview", title: "Overview" }, "no heading")).toBe("Overview");
  });
});

describe("orderWithinFolder", () => {
  it("puts a page named after its folder first, like an overview", () => {
    const items = [{ id: "nodes/docs/platform/plugins/building-a-plugin", title: "Building a Plugin" }, { id: "nodes/docs/platform/plugins/google-drive", title: "Google Drive" }, { id: "nodes/docs/platform/plugins/plugins", title: "Plugins" }];
    expect(orderWithinFolder("docs/platform/plugins", items).map((n) => n.id.split("/").pop())).toEqual(["plugins", "building-a-plugin", "google-drive"]);
  });
});

describe("ancestorsOf", () => {
  it("lists every folder above a page, shallowest first, so a deep link can open the whole chain", () => {
    expect(ancestorsOf("nodes/docs/platform/plugins/google-drive")).toEqual(["docs", "docs/platform", "docs/platform/plugins"]);
    expect(ancestorsOf("nodes/readme")).toEqual([]);
  });
});
