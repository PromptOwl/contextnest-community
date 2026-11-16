/**
 * Row diff for a table draft in the review screen: added / changed / removed
 * rows by `:key`, rendered as readable lines.
 */
import { describe, it, expect } from "vitest";
import { tableRowDiff, rowDiffLines } from "../ui/src/lib/table-row-diff";

const BEFORE = "# kept\nid:key,stage,amount:number\nr1,lead,10\nr2,won,20\nr3,lost,5";

describe("tableRowDiff", () => {
  it("reports only the row that changed, cell by cell", () => {
    const d = tableRowDiff(BEFORE, BEFORE.replace("r1,lead,10", "r1,qualified,10"))!;
    expect(d.keyColumn).toBe("id");
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([{ key: "r1", cells: [{ column: "stage", before: "lead", after: "qualified" }] }]);
  });

  it("reports added and removed rows by key", () => {
    const after = BEFORE.replace("\nr2,won,20", "") + "\nr4,lead,7";
    const d = tableRowDiff(BEFORE, after)!;
    expect(d.added).toEqual([{ key: "r4", values: { id: "r4", stage: "lead", amount: "7" } }]);
    expect(d.removed).toEqual([{ key: "r2", values: { id: "r2", stage: "won", amount: "20" } }]);
    expect(d.changed).toEqual([]);
  });

  it("handles quoted cells", () => {
    const d = tableRowDiff('id:key,note\na,"x, y"', 'id:key,note\na,"x, z"')!;
    expect(d.changed[0].cells[0]).toEqual({ column: "note", before: "x, y", after: "x, z" });
  });

  it("is null when there is no :key column or the header changed", () => {
    expect(tableRowDiff("a,b\n1,2", "a,b\n1,3")).toBeNull();
    expect(tableRowDiff("id:key,a\n1,2", "id:key,b\n1,2")).toBeNull();
    expect(tableRowDiff("", "id:key\n1")).toBeNull();
  });

  it("is null when a key repeats (the diff by key would be ambiguous)", () => {
    expect(tableRowDiff("id:key,a\n1,x\n1,y", "id:key,a\n1,x")).toBeNull();
  });
});

describe("rowDiffLines", () => {
  it("reads as one line per row", () => {
    const after = BEFORE.replace("r1,lead,10", "r1,qualified,10").replace("\nr3,lost,5", "") + "\nr4,lead,7";
    expect(rowDiffLines(tableRowDiff(BEFORE, after)!)).toEqual([
      "+ r4: id=r4, stage=lead, amount=7",
      "~ r1: stage: lead → qualified",
      "- r3: id=r3, stage=lost, amount=5",
    ]);
  });

  it("says so when nothing changed", () => {
    expect(rowDiffLines(tableRowDiff(BEFORE, BEFORE)!)).toEqual(["No row changes."]);
  });
});
