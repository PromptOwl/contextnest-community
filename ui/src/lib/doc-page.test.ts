/**
 * The document page's chrome rules — what the sidebar tree shows for the
 * open document, and when the comments rail is on screen.
 *
 * Written before the page was rebuilt, so the rail rule pins the one
 * behaviour the rebuild could break: a deep link to a thread, comment mode,
 * and pinning a comment to a selection all still put the rail on screen even
 * though it now starts closed.
 */
import { describe, it, expect } from "vitest";
import {
  groupNodesByFolder,
  folderAncestors,
  nextCommentsOpen,
  readDocPagePrefs,
  writeDocPagePrefs,
  DOC_PAGE_PREFS_KEY,
} from "./doc-page";
import { buildFolderTree, type FolderTreeNode } from "../components/FolderTree";

const node = (id: string) => ({ id, title: id.split("/").pop()! });

/** Every folder row, depth-first, as "path count", then the doc ids under it. */
function outline(n: FolderTreeNode): string[] {
  return [
    ...n.docs.map((d) => `  ${d.id}`),
    ...n.children.flatMap((c) => [`${c.path} ${c.count}`, ...outline(c)]),
  ];
}

describe("groupNodesByFolder", () => {
  it("files each node under the folder its id sits in, loose docs at the root", () => {
    const groups = groupNodesByFolder([
      node("nodes/getting-started"),
      node("nodes/gtm/questions"),
      node("nodes/gtm/pricing/tiers"),
      node("nodes/personal/cv"),
    ]);
    expect(groups.map((g) => [g.folder, g.items.map((i) => i.id)])).toEqual([
      ["", ["nodes/getting-started"]],
      ["gtm", ["nodes/gtm/questions"]],
      ["gtm/pricing", ["nodes/gtm/pricing/tiers"]],
      ["personal", ["nodes/personal/cv"]],
    ]);
  });

  it("feeds buildFolderTree so a nested doc lands under its full folder chain", () => {
    // The sidebar reuses the nest page's tree. A regression here would show
    // "gtm/pricing/tiers" as a loose root doc, or lose the gtm row entirely.
    const tree = buildFolderTree(
      groupNodesByFolder([node("nodes/gtm/pricing/tiers"), node("nodes/readme")]),
      "",
      // Known folders keep every level expandable (no chain compaction).
      [{ path: "gtm", total: 1 }, { path: "gtm/pricing", total: 1 }],
    );
    expect(outline(tree)).toEqual([
      "  nodes/readme",
      "gtm 0",
      "gtm/pricing 1",
      "  nodes/gtm/pricing/tiers",
    ]);
  });

  it("sorts docs by title within a folder, case-insensitively", () => {
    const groups = groupNodesByFolder([
      { id: "nodes/b", title: "beta" },
      { id: "nodes/a", title: "Alpha" },
      { id: "nodes/c", title: "charlie" },
    ]);
    expect(groups[0].items.map((i) => i.title)).toEqual(["Alpha", "beta", "charlie"]);
  });
});

describe("folderAncestors", () => {
  it("lists every folder on the way to the document, so the tree can open them", () => {
    expect(folderAncestors("nodes/gtm/pricing/tiers")).toEqual(["gtm", "gtm/pricing"]);
  });
  it("is empty for a loose root document and for a new one", () => {
    expect(folderAncestors("nodes/readme")).toEqual([]);
    expect(folderAncestors("new")).toEqual([]);
  });
});

describe("nextCommentsOpen — the rail starts closed but never hides a thread you asked for", () => {
  it("stays closed by default when nothing asks for it", () => {
    expect(nextCommentsOpen(false, {})).toBe(false);
  });
  it("respects an explicit open", () => {
    expect(nextCommentsOpen(true, {})).toBe(true);
  });
  it("opens for a deep link to a thread", () => {
    expect(nextCommentsOpen(false, { initialThreadId: "t1" })).toBe(true);
  });
  it("opens when comment mode is switched on", () => {
    expect(nextCommentsOpen(false, { commentMode: true })).toBe(true);
  });
  it("opens when a comment is pinned to a selection", () => {
    expect(nextCommentsOpen(false, { pendingAnchor: true })).toBe(true);
  });
  it("opens when a thread is focused from the document body", () => {
    expect(nextCommentsOpen(false, { activeThreadId: "t9" })).toBe(true);
  });
});

describe("doc page prefs", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      map: m,
    };
  };

  it("defaults to sidebar open and comments closed", () => {
    expect(readDocPagePrefs(memory())).toEqual({
      sidebarCollapsed: false,
      commentsOpen: false,
    });
  });

  it("round-trips a change and merges partial writes", () => {
    const s = memory();
    writeDocPagePrefs(s, { commentsOpen: true });
    expect(readDocPagePrefs(s)).toEqual({
      sidebarCollapsed: false,
      commentsOpen: true,
    });
    writeDocPagePrefs(s, { sidebarCollapsed: true });
    expect(readDocPagePrefs(s)).toEqual({
      sidebarCollapsed: true,
      commentsOpen: true,
    });
    expect(s.map.has(DOC_PAGE_PREFS_KEY)).toBe(true);
  });

  it("ignores garbage in storage and a storage that throws", () => {
    const s = memory();
    s.setItem(DOC_PAGE_PREFS_KEY, "{not json");
    expect(readDocPagePrefs(s)).toEqual({
      sidebarCollapsed: false,
      commentsOpen: false,
    });
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDocPagePrefs(throwing)).toEqual({
      sidebarCollapsed: false,
      commentsOpen: false,
    });
    expect(() => writeDocPagePrefs(throwing, { commentsOpen: true })).not.toThrow();
  });
});
