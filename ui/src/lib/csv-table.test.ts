import { describe, expect, it } from "vitest";
import { editCsvTable, parseDelimited } from "./csv-table";

const csv = "# owner: ops\nsku:key,price:number\nA,1\nB,2";

describe("editCsvTable", () => {
  it("adds an empty row that survives a re-parse", () => {
    const next = editCsvTable(csv, { op: "add-row" });
    expect(next).toBe("# owner: ops\nsku:key,price:number\nA,1\nB,2\n,");
    expect(parseDelimited(next, ",", true)).toHaveLength(5);
  });

  it("removes a data row by index, leaving comments alone", () => {
    expect(editCsvTable(csv, { op: "delete-row", row: 0 })).toBe(
      "# owner: ops\nsku:key,price:number\nB,2",
    );
  });

  it("adds and removes columns across header and data rows", () => {
    const added = editCsvTable(csv, { op: "add-column" });
    expect(added).toBe("# owner: ops\nsku:key,price:number,column_3\nA,1,\nB,2,");
    expect(editCsvTable(added, { op: "delete-column", col: 0 })).toBe(
      "# owner: ops\nprice:number,column_3\n1,\n2,",
    );
  });

  it("sets header and data cells, quoting when needed", () => {
    const next = editCsvTable(csv, { op: "set-cell", row: 1, col: 0, value: 'B, "big"' });
    expect(editCsvTable(next, { op: "set-cell", row: -1, col: 1, value: "cost" })).toBe(
      '# owner: ops\nsku:key,cost\nA,1\n"B, ""big""",2',
    );
  });

  it("starts a table from an empty body", () => {
    expect(editCsvTable("", { op: "add-column" })).toBe("column_1");
  });
});
