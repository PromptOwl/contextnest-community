/**
 * Row operations on a table node's CSV body (append / update / delete by
 * `:key`), the pure half of POST /nests/:id/nodes/:nodeId/rows.
 *
 * Rules pinned here: typed validation against the header, unknown columns
 * refused, `:key` uniqueness, all-or-nothing, and minimal edits — untouched
 * lines (comments, blank lines, quoting) stay byte-for-byte, so the review
 * diff shows only the rows that changed.
 */
import { describe, it, expect } from "vitest";
import { applyRowOps, parseRowOps, ROW_OPS_CAPS } from "../src/tables/row-ops.js";
import { parseTable } from "../src/tables/service.js";

const BODY = [
  "# pipeline, hand-kept",
  "id:key,stage,amount:number,closed:date",
  "r1,lead,10,2026-01-02",
  "",
  'r2,"won, finally",20,2026-02-03',
  "r3,lost,5,",
].join("\n");

const rowsOf = (body: string) => parseTable(body).rows;

describe("parseRowOps", () => {
  it("accepts the three op shapes", () => {
    expect(
      parseRowOps([
        { op: "append", row: { id: "r9" } },
        { op: "update", key: "r1", set: { stage: "won" } },
        { op: "delete", key: "r3" },
      ]),
    ).toHaveLength(3);
  });

  it.each([
    ["not an array", { op: "append" }],
    ["empty", []],
    ["unknown op", [{ op: "upsert", key: "r1" }]],
    ["append without row", [{ op: "append" }]],
    ["update without set", [{ op: "update", key: "r1" }]],
    ["update with empty set", [{ op: "update", key: "r1", set: {} }]],
    ["delete without key", [{ op: "delete" }]],
    ["object value", [{ op: "append", row: { id: { x: 1 } } }]],
    ["array row", [{ op: "append", row: ["r1"] }]],
  ])("refuses %s", (_label, input) => {
    expect(() => parseRowOps(input)).toThrow();
  });

  it(`refuses more than ${ROW_OPS_CAPS.MAX_OPS} ops`, () => {
    const ops = Array.from({ length: ROW_OPS_CAPS.MAX_OPS + 1 }, (_, i) => ({ op: "delete", key: `r${i}` }));
    expect(() => parseRowOps(ops)).toThrow(/at most/);
  });
});

describe("applyRowOps", () => {
  it("updates one row and leaves every other line byte-for-byte", () => {
    const out = applyRowOps(BODY, parseRowOps([{ op: "update", key: "r1", set: { stage: "qualified" } }]));
    const before = BODY.split("\n");
    const after = out.body.split("\n");
    expect(after).toHaveLength(before.length);
    const changed = after.map((l, i) => (l === before[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toEqual([2]);
    expect(after[2]).toBe("r1,qualified,10,2026-01-02");
    expect(out.updated).toBe(1);
    expect(out.changed).toBe(true);
  });

  it("appends at the end, quoting cells that need it", () => {
    const out = applyRowOps(BODY, parseRowOps([{ op: "append", row: { id: "r4", stage: 'say "hi", ok', amount: 7 } }]));
    expect(out.body.split("\n").slice(0, 6).join("\n")).toBe(BODY);
    expect(out.body.endsWith('r4,"say ""hi"", ok",7,')).toBe(true);
    expect(rowsOf(out.body).at(-1)).toEqual(["r4", 'say "hi", ok', "7", ""]);
  });

  it("quotes a first cell that would otherwise read as a comment", () => {
    const out = applyRowOps(BODY, parseRowOps([{ op: "append", row: { id: "#5", stage: "lead" } }]));
    expect(rowsOf(out.body).at(-1)?.[0]).toBe("#5");
  });

  it("deletes by key", () => {
    const out = applyRowOps(BODY, parseRowOps([{ op: "delete", key: "r2" }]));
    expect(rowsOf(out.body).map((r) => r[0])).toEqual(["r1", "r3"]);
    expect(out.body).toContain("# pipeline, hand-kept");
    expect(out.deleted).toBe(1);
  });

  it("applies ops in order (append then update the new row)", () => {
    const out = applyRowOps(
      BODY,
      parseRowOps([
        { op: "append", row: { id: "r4", stage: "lead" } },
        { op: "update", key: "r4", set: { stage: "won" } },
      ]),
    );
    expect(rowsOf(out.body).at(-1)?.slice(0, 2)).toEqual(["r4", "won"]);
  });

  it("matches a numeric key given as a number", () => {
    const body = "n:key:number,v\n1,a\n2,b";
    const out = applyRowOps(body, parseRowOps([{ op: "update", key: 2, set: { v: "z" } }]));
    expect(out.body).toBe("n:key:number,v\n1,a\n2,z");
  });

  it("reports an unchanged body when the values are already there", () => {
    const out = applyRowOps(BODY, parseRowOps([{ op: "update", key: "r1", set: { stage: "lead" } }]));
    expect(out.changed).toBe(false);
    expect(out.body).toBe(BODY);
    expect(out.updated).toBe(0);
  });

  describe("refusals (all-or-nothing: a refusal is a throw, so nothing is returned to write)", () => {
    const refuse = (ops: unknown, body = BODY) => () => applyRowOps(body, parseRowOps(ops));

    it("a duplicate key on append", () => {
      expect(refuse([{ op: "append", row: { id: "r1", stage: "x" } }])).toThrow(/already/);
    });
    it("a duplicate key within the same batch", () => {
      expect(
        refuse([
          { op: "append", row: { id: "r8" } },
          { op: "append", row: { id: "r8" } },
        ]),
      ).toThrow(/already/);
    });
    it("a non-number in a :number column", () => {
      expect(refuse([{ op: "append", row: { id: "r4", amount: "lots" } }])).toThrow(/number/);
      expect(refuse([{ op: "update", key: "r1", set: { amount: "ten" } }])).toThrow(/number/);
    });
    it("a non-date in a :date column", () => {
      expect(refuse([{ op: "update", key: "r1", set: { closed: "someday" } }])).toThrow(/date/);
    });
    it("an unknown column", () => {
      expect(refuse([{ op: "update", key: "r1", set: { owner: "me" } }])).toThrow(/unknown column/);
      expect(refuse([{ op: "append", row: { id: "r4", owner: "me" } }])).toThrow(/unknown column/);
    });
    it("an append without its key", () => {
      expect(refuse([{ op: "append", row: { stage: "lead" } }])).toThrow(/key/);
    });
    it("an update or delete of a key that is not there", () => {
      expect(refuse([{ op: "update", key: "nope", set: { stage: "x" } }])).toThrow(/no row/);
      expect(refuse([{ op: "delete", key: "nope" }])).toThrow(/no row/);
    });
    it("changing the key column", () => {
      expect(refuse([{ op: "update", key: "r1", set: { id: "r100" } }])).toThrow(/key/);
    });
    it("a value with a line break", () => {
      expect(refuse([{ op: "update", key: "r1", set: { stage: "a\nb" } }])).toThrow(/line break/);
    });
    it("update/delete on a table with no :key column", () => {
      expect(refuse([{ op: "delete", key: "a" }], "name,v\na,1")).toThrow(/:key/);
    });
    it("update/delete when the key is ambiguous in the stored table", () => {
      expect(refuse([{ op: "delete", key: "a" }], "k:key,v\na,1\na,2")).toThrow(/more than one/);
    });
    it("a later bad op after a good one", () => {
      expect(
        refuse([
          { op: "update", key: "r1", set: { stage: "won" } },
          { op: "update", key: "r2", set: { amount: "NaN-ish" } },
        ]),
      ).toThrow();
    });
  });

  describe("review round 1", () => {
    it("keeps each untouched line's own line ending in a mixed-EOL body", () => {
      const body = "k:key,v\n1,a\r\n2,b\n3,c";
      const out = applyRowOps(body, parseRowOps([{ op: "update", key: "3", set: { v: "z" } }]));
      expect(out.body).toBe("k:key,v\n1,a\r\n2,b\n3,z");
      const del = applyRowOps(body, parseRowOps([{ op: "delete", key: "1" }]));
      expect(del.body).toBe("k:key,v\n2,b\n3,c");
    });
    it("refuses hex/odd numbers and non-ISO dates", () => {
      expect(() => applyRowOps(BODY, parseRowOps([{ op: "update", key: "r1", set: { amount: "0x10" } }]))).toThrow(/number/);
      expect(() => applyRowOps(BODY, parseRowOps([{ op: "update", key: "r1", set: { amount: "Infinity" } }]))).toThrow(/number/);
      expect(() => applyRowOps(BODY, parseRowOps([{ op: "update", key: "r1", set: { closed: "1" } }]))).toThrow(/date/);
      expect(applyRowOps(BODY, parseRowOps([{ op: "update", key: "r1", set: { amount: "-1.5e3", closed: "2026-03-04T10:00:00Z" } }])).changed).toBe(true);
    });
    it("refuses to write a table whose header repeats a column name", () => {
      expect(() => applyRowOps("k:key,v,v\n1,a,b", parseRowOps([{ op: "update", key: "1", set: { v: "z" } }]))).toThrow(/more than once/);
    });
  });

  describe("code-review round", () => {
    it("an omitted column named like an Object.prototype key stays empty", () => {
      const out = applyRowOps("id:key,constructor,toString\n1,a,b", parseRowOps([{ op: "append", row: { id: "2" } }]));
      expect(out.body).toBe("id:key,constructor,toString\n1,a,b\n2,,");
    });
    it("an update keeps cells a ragged row has past the header", () => {
      const out = applyRowOps("id:key,stage\nr1,lead,call back friday", parseRowOps([{ op: "update", key: "r1", set: { stage: "won" } }]));
      expect(out.body).toBe("id:key,stage\nr1,won,call back friday");
    });
    it("refuses an impossible calendar date", () => {
      expect(() => applyRowOps(BODY, parseRowOps([{ op: "update", key: "r1", set: { closed: "2024-02-30" } }]))).toThrow(/date/);
      expect(applyRowOps(BODY, parseRowOps([{ op: "update", key: "r1", set: { closed: "2024-02-29" } }])).changed).toBe(true);
    });
  });

  it("appends to a table with no :key column", () => {
    const out = applyRowOps("name,v\na,1", parseRowOps([{ op: "append", row: { name: "b", v: "2" } }]));
    expect(out.body).toBe("name,v\na,1\nb,2");
  });
});
