/**
 * Lazily-expanded folder trees: rows must exist for folders whose documents
 * have never been fetched, or there is nothing to click to fetch them.
 */
import { describe, it, expect } from "vitest";
import { buildFolderTree, type FolderTreeNode } from "./FolderTree";

/** Every folder row, depth-first, as "path@depth count/total". */
function rows(node: FolderTreeNode): string[] {
  return node.children.flatMap((c) => [
    `${c.path}@${c.depth} ${c.count}/${c.total}`,
    ...rows(c),
  ]);
}

const doc = (id: string) => ({ id, title: id });

describe("buildFolderTree with lazily-loaded folders", () => {
  const known = [
    { path: "eng", total: 4 },
    { path: "eng/api", total: 3 },
    { path: "gtm", total: 2 },
  ];

  it("gives an unfetched folder a row carrying the server's total", () => {
    // Nothing loaded anywhere — the tree is still fully navigable.
    expect(rows(buildFolderTree([], "", known))).toEqual([
      "eng@0 0/4",
      "eng/api@1 0/3",
      "gtm@0 0/2",
    ]);
  });

  it("counts loaded documents without shrinking the server's total", () => {
    // `gtm` fully loaded; `eng/api` has one of its three fetched so far.
    const tree = buildFolderTree(
      [
        { folder: "gtm", items: [doc("nodes/gtm/a"), doc("nodes/gtm/b")] },
        { folder: "eng/api", items: [doc("nodes/eng/api/x")] },
      ],
      "",
      known,
    );
    expect(rows(tree)).toEqual([
      "eng@0 0/4",
      "eng/api@1 1/3",
      "gtm@0 2/2",
    ]);
  });

  it("keeps every level as its own row so each can be expanded", () => {
    // Without `known`, `a` folds into `a/b` — one row, and no way to open `a`.
    const eager = buildFolderTree([{ folder: "a/b", items: [doc("nodes/a/b/x")] }], "");
    expect(rows(eager)).toEqual(["a/b@0 1/1"]);

    const lazy = buildFolderTree(
      [{ folder: "a/b", items: [doc("nodes/a/b/x")] }],
      "",
      [{ path: "a", total: 1 }, { path: "a/b", total: 1 }],
    );
    expect(rows(lazy)).toEqual(["a@0 0/1", "a/b@1 1/1"]);
  });

  it("ignores known folders outside the scoped base", () => {
    const tree = buildFolderTree([], "eng", known);
    expect(rows(tree)).toEqual(["eng/api@0 0/3"]);
  });

  it("leaves the eager tree untouched when no folders are supplied", () => {
    const tree = buildFolderTree(
      [
        { folder: "", items: [doc("nodes/loose")] },
        { folder: "gtm", items: [doc("nodes/gtm/a")] },
      ],
      "",
    );
    expect(rows(tree)).toEqual(["gtm@0 1/1"]);
    expect(tree.docs.map((d) => d.id)).toEqual(["nodes/loose"]);
  });
});
