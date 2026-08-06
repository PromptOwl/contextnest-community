/**
 * DiffViewer parses the patches the engine stores per version.
 *
 * Every non-keyframe version is saved as a v{N}.diff file holding `createPatch`
 * output, headed by `Index: vN`, an `====` underline and `---`/`+++` lines.
 * That preamble is dropped entirely — the UI already heads the diff with
 * "Changes in vN (from vM)" — and it must not consume old/new line numbers
 * before the first `@@` sets them.
 */
import { describe, it, expect } from "vitest";
import { toRows } from "../ui/src/components/governance/diff-rows";

// Shape of what the engine writes for a version, trimmed to one hunk.
const STORED_PATCH = [
  "Index: v2",
  "===================================================================",
  "--- v2\tv2",
  "+++ v2\tv3",
  "@@ -1,4 +1,4 @@",
  " title: doc",
  "-old line",
  "+new line",
  " tail",
].join("\n");

describe("toRows", () => {
  it("drops the Index:/====/---/+++ preamble", () => {
    const rows = toRows(STORED_PATCH);
    expect(rows[0]).toMatchObject({ kind: "hunk", text: "@@ -1,4 +1,4 @@" });
    expect(rows.some((r) => r.text.startsWith("Index:"))).toBe(false);
  });

  it("keeps a deleted frontmatter rule inside a hunk", () => {
    // "-" + "---" looks like a `---` file header but is a deleted line.
    const rows = toRows(["@@ -1,2 +1,1 @@", "----", " title: doc"].join("\n"));
    expect(rows[1]).toMatchObject({ kind: "del", text: "---", oldNo: 1 });
  });

  it("numbers hunk lines from the @@ header", () => {
    const rows = toRows(STORED_PATCH);
    const ctx = rows.find((r) => r.text === "title: doc")!;
    expect(ctx).toMatchObject({ kind: "ctx", oldNo: 1, newNo: 1 });

    const del = rows.find((r) => r.text === "old line")!;
    expect(del).toMatchObject({ kind: "del", oldNo: 2, newNo: null });

    const add = rows.find((r) => r.text === "new line")!;
    expect(add).toMatchObject({ kind: "add", oldNo: null, newNo: 2 });

    // Both sides advanced past the changed line.
    const tail = rows.find((r) => r.text === "tail")!;
    expect(tail).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 3 });
  });

  it("still parses the prefixed form the editor's client-side diff emits", () => {
    const rows = toRows("  a\n- b\n+ c");
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "del", "add"]);
  });
});
