/**
 * Unified-patch parser for {@link DiffViewer}. Framework-free so it's
 * unit-testable without a DOM or the `@/` alias, same as diff-util.ts.
 *
 * Handles both patch flavours the app renders:
 *   - what the engine stores per version (`createPatch` output: an `Index: vN`
 *     header, an `====` underline, `---`/`+++` file lines, then `@@` hunks)
 *   - the `+ `/`- `/`  ` prefixed form unifiedDiff() emits for the editor's
 *     unsaved-changes preview, which has no hunk headers at all
 */

export type Row = {
  kind: "add" | "del" | "ctx" | "hunk" | "file";
  oldNo: number | null;
  newNo: number | null;
  text: string;
};

function parseHunkHeader(
  line: string,
): { oldStart: number; newStart: number } | null {
  // @@ -oldStart,oldLen +newStart,newLen @@
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

export function toRows(patch: string): Row[] {
  const lines = patch.split(/\r?\n/);
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      // `Index: vN` + its `====` underline head every patch the engine stores
      // for a version. Counted as context they would consume line numbers
      // before the first @@ sets them, shifting the whole first hunk.
      line.startsWith("Index: ") ||
      /^=+$/.test(line)
    ) {
      rows.push({ kind: "file", oldNo: null, newNo: null, text: line });
      continue;
    }
    const hunk = parseHunkHeader(line);
    if (hunk) {
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else {
      // context (leading space) or blank tail line
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return rows;
}
