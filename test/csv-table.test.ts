import { describe, it, expect } from "vitest";
import {
  parseDelimited,
  detectDelimiter,
  detectHeaderRow,
  isNumericLike,
  rowsToMarkdownTable,
  looksLikeDelimitedTable,
  delimitedToMarkdownTable,
  LARGE_TABLE_ROW_THRESHOLD,
} from "../ui/src/lib/csv-table";

describe("parseDelimited", () => {
  it("parses simple CSV", () => {
    expect(parseDelimited("a,b,c\nd,e,f", ",")).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("parses TSV", () => {
    expect(parseDelimited("a\tb\nc\td", "\t")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles quoted fields containing the delimiter", () => {
    expect(parseDelimited('"a,x",b\nc,d', ",")).toEqual([
      ["a,x", "b"],
      ["c", "d"],
    ]);
  });

  it("handles escaped quotes inside quoted fields", () => {
    expect(parseDelimited('"say ""hi""",b', ",")).toEqual([['say "hi"', "b"]]);
  });

  it("handles newlines inside quoted fields", () => {
    expect(parseDelimited('"line1\nline2",b\nc,d', ",")).toEqual([
      ["line1\nline2", "b"],
      ["c", "d"],
    ]);
  });

  it("handles CRLF row endings, including inside quotes", () => {
    expect(parseDelimited('a,b\r\n"x\r\ny",z\r\n', ",")).toEqual([
      ["a", "b"],
      ["x\r\ny", "z"],
    ]);
  });

  it("ignores a trailing newline and blank lines", () => {
    expect(parseDelimited("a,b\n\nc,d\n", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("skips a leading UTF-8 BOM", () => {
    expect(parseDelimited("﻿a,b\nc,d", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps empty fields", () => {
    expect(parseDelimited("a,,c\n,b,", ",")).toEqual([
      ["a", "", "c"],
      ["", "b", ""],
    ]);
  });

  it("treats a quote inside an unquoted field as literal", () => {
    expect(parseDelimited('5" nail,b', ",")).toEqual([['5" nail', "b"]]);
  });
});

describe("detectDelimiter", () => {
  it("prefers tab over comma (spreadsheet clipboards are TSV)", () => {
    expect(detectDelimiter("a\tb,x\nc\td,y")).toBe("\t");
  });

  it("detects comma", () => {
    expect(detectDelimiter("a,b\nc,d")).toBe(",");
  });

  it("detects semicolon when commas do not form a grid", () => {
    expect(detectDelimiter("a;b\nc;d")).toBe(";");
  });

  it("returns null for undelimited text", () => {
    expect(detectDelimiter("hello\nworld")).toBeNull();
  });

  it("rejects a delimiter that yields inconsistent columns", () => {
    // Commas appear but rows disagree on width; no tab/semicolon either.
    expect(detectDelimiter("a,b,c\nd,e")).toBeNull();
  });
});

describe("isNumericLike", () => {
  it("accepts numbers, currency, thousands separators, percents", () => {
    for (const v of ["1", "-2.5", "+3", "1,204.50", "$99", "12%", "€1,000"]) {
      expect(isNumericLike(v), v).toBe(true);
    }
  });

  it("rejects words and empty strings", () => {
    for (const v of ["Revenue", "", "Q1 2026", "N/A"]) {
      expect(isNumericLike(v), v).toBe(false);
    }
  });
});

describe("detectHeaderRow", () => {
  it("detects text labels over numeric data", () => {
    expect(
      detectHeaderRow([
        ["Name", "Score"],
        ["Ada", "99"],
      ]),
    ).toBe(true);
  });

  it("rejects when the first row itself is numeric", () => {
    expect(
      detectHeaderRow([
        ["1", "2"],
        ["3", "4"],
      ]),
    ).toBe(false);
  });

  it("rejects when the first row has empty cells", () => {
    expect(
      detectHeaderRow([
        ["Name", ""],
        ["Ada", "99"],
      ]),
    ).toBe(false);
  });

  it("all-text data: header only when first-row labels are unique", () => {
    expect(
      detectHeaderRow([
        ["City", "Country"],
        ["Paris", "France"],
      ]),
    ).toBe(true);
    expect(
      detectHeaderRow([
        ["yes", "yes"],
        ["no", "maybe"],
      ]),
    ).toBe(false);
  });

  it("a single row is never a header", () => {
    expect(detectHeaderRow([["Name", "Score"]])).toBe(false);
  });
});

describe("rowsToMarkdownTable", () => {
  it("emits a GFM table with the detected header", () => {
    const md = rowsToMarkdownTable([
      ["Name", "Score"],
      ["Ada", "99"],
    ]);
    expect(md).toBe("| Name | Score |\n| --- | --- |\n| Ada | 99 |");
  });

  it("generates Column N headers when there is no header row", () => {
    const md = rowsToMarkdownTable(
      [
        ["1", "2"],
        ["3", "4"],
      ],
      { hasHeader: false },
    );
    expect(md).toBe(
      "| Column 1 | Column 2 |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |",
    );
  });

  it("respects an explicit hasHeader override", () => {
    const md = rowsToMarkdownTable(
      [
        ["1", "2"],
        ["3", "4"],
      ],
      { hasHeader: true },
    );
    expect(md).toBe("| 1 | 2 |\n| --- | --- |\n| 3 | 4 |");
  });

  it("escapes pipes and backslashes in cells", () => {
    const md = rowsToMarkdownTable(
      [["a|b", "c\\d"]],
      { hasHeader: false },
    );
    expect(md).toContain("| a\\|b | c\\\\d |");
  });

  it("collapses in-cell newlines to <br>", () => {
    const md = rowsToMarkdownTable(
      [["line1\nline2", "x"]],
      { hasHeader: false },
    );
    expect(md).toContain("| line1<br>line2 | x |");
  });

  it("pads ragged rows to the widest row", () => {
    const md = rowsToMarkdownTable(
      [
        ["a", "b", "c"],
        ["d"],
      ],
      { hasHeader: true },
    );
    expect(md).toBe("| a | b | c |\n| --- | --- | --- |\n| d |  |  |");
  });

  it("returns empty string for no rows", () => {
    expect(rowsToMarkdownTable([])).toBe("");
  });
});

describe("looksLikeDelimitedTable (paste detection)", () => {
  it("accepts 2-row consistent TSV", () => {
    const hit = looksLikeDelimitedTable("Name\tScore\nAda\t99");
    expect(hit).not.toBeNull();
    expect(hit!.delimiter).toBe("\t");
    expect(hit!.rows).toEqual([
      ["Name", "Score"],
      ["Ada", "99"],
    ]);
  });

  it("rejects single-line text", () => {
    expect(looksLikeDelimitedTable("a\tb\tc")).toBeNull();
    expect(looksLikeDelimitedTable("a,b,c")).toBeNull();
  });

  it("rejects inconsistent TSV column counts", () => {
    expect(looksLikeDelimitedTable("a\tb\nc\td\te")).toBeNull();
  });

  it("rejects 2-row CSV (comma bar is higher than tab)", () => {
    expect(looksLikeDelimitedTable("Hello, world\nFoo, bar")).toBeNull();
  });

  it("accepts 3-row consistent CSV", () => {
    const hit = looksLikeDelimitedTable("Name,Score\nAda,99\nGrace,97");
    expect(hit).not.toBeNull();
    expect(hit!.delimiter).toBe(",");
    expect(hit!.rows).toHaveLength(3);
  });

  it("accepts 3-row consistent semicolon-delimited text (same bar as CSV)", () => {
    const hit = looksLikeDelimitedTable("Name;Score\nAda;99\nGrace;97");
    expect(hit).not.toBeNull();
    expect(hit!.delimiter).toBe(";");
    expect(hit!.rows).toEqual([
      ["Name", "Score"],
      ["Ada", "99"],
      ["Grace", "97"],
    ]);
  });

  it("rejects 2-row semicolon text (below the CSV bar)", () => {
    expect(looksLikeDelimitedTable("a;b\nc;d")).toBeNull();
  });

  it("prefers comma over semicolon when both form a grid", () => {
    const hit = looksLikeDelimitedTable("a,x;y\nb,p;q\nc,m;n");
    expect(hit).not.toBeNull();
    expect(hit!.delimiter).toBe(",");
  });

  it("rejects prose paragraphs that happen to contain commas", () => {
    const prose = [
      "In the beginning, the team shipped a small prototype that only handled the basics, and everyone was happy with it for a while, until the requirements grew well beyond what anyone had originally planned for the quarter",
      "Later, the second iteration added governance, versioning, and review workflows, which made the product far more useful to larger organizations that needed auditability across all of their context documents and prompts",
      "Finally, the third iteration unified everything, closing the loop between authoring, review, and retrieval so that agents and humans could safely share one source of truth without stepping on each other",
    ].join("\n");
    expect(looksLikeDelimitedTable(prose)).toBeNull();
  });

  it("rejects plain multi-line text with no delimiter", () => {
    expect(looksLikeDelimitedTable("hello\nworld\nagain")).toBeNull();
  });

  it("handles quoted CSV cells containing commas and newlines", () => {
    const hit = looksLikeDelimitedTable(
      'Name,Notes\nAda,"math, logic"\nGrace,"navy\ncompilers"',
    );
    expect(hit).not.toBeNull();
    expect(hit!.rows[1]).toEqual(["Ada", "math, logic"]);
    expect(hit!.rows[2]).toEqual(["Grace", "navy\ncompilers"]);
  });
});

describe("delimitedToMarkdownTable (end-to-end)", () => {
  it("converts auto-detected TSV with header", () => {
    const out = delimitedToMarkdownTable("Name\tScore\nAda\t99");
    expect(out).not.toBeNull();
    expect(out!.hasHeader).toBe(true);
    expect(out!.dataRows).toBe(1);
    expect(out!.markdown).toBe(
      "| Name | Score |\n| --- | --- |\n| Ada | 99 |",
    );
  });

  it("forces a delimiter when given one", () => {
    const out = delimitedToMarkdownTable("a;b\nc;d", { delimiter: ";" });
    expect(out!.markdown).toContain("| a | b |");
  });

  it("handles single-column input via the comma fallback", () => {
    const out = delimitedToMarkdownTable("Fruit\napple\nbanana");
    expect(out).not.toBeNull();
    expect(out!.markdown.split("\n")[0]).toBe("| Fruit |");
  });

  it("returns null for empty input", () => {
    expect(delimitedToMarkdownTable("")).toBeNull();
    expect(delimitedToMarkdownTable("\n\n")).toBeNull();
  });

  it("counts data rows for the large-table guardrail", () => {
    const big =
      "col1,col2\n" +
      Array.from({ length: LARGE_TABLE_ROW_THRESHOLD + 1 }, (_, i) => `${i},x`).join(
        "\n",
      );
    const out = delimitedToMarkdownTable(big);
    expect(out!.hasHeader).toBe(true);
    expect(out!.dataRows).toBe(LARGE_TABLE_ROW_THRESHOLD + 1);
    expect(out!.dataRows > LARGE_TABLE_ROW_THRESHOLD).toBe(true);
  });
});
