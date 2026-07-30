/**
 * DiffViewer parses the patches the engine stores per version.
 *
 * Every non-keyframe version is saved as a v{N}.diff file holding `createPatch`
 * output, which is headed by `Index: vN` and an `====` underline. Those two
 * lines are not part of any hunk: counted as context they consume old/new line
 * numbers before the first `@@` sets them, so every row in the first hunk
 * renders two lines off.
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
  it("treats the Index: and ==== lines as headers, not content", () => {
    const rows = toRows(STORED_PATCH);
    expect(rows[0]).toMatchObject({ kind: "file", text: "Index: v2" });
    expect(rows[1].kind).toBe("file");
    // Headers carry no line numbers, so they cannot advance the counters.
    expect(rows[0].oldNo).toBeNull();
    expect(rows[1].oldNo).toBeNull();
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
