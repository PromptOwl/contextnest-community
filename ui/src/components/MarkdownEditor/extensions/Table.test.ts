import { describe, it, expect } from "vitest";
import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import { serializeTable } from "./Table";
import { rowsToMarkdownTable } from "../../../lib/csv-table";

// Minimal schema: just the table shape and the marks serializeTable reads.
const schema = new Schema({
  nodes: {
    doc: { content: "table+" },
    table: { content: "tableRow+" },
    tableRow: { content: "(tableHeader | tableCell)*" },
    tableHeader: { content: "paragraph" },
    tableCell: { content: "paragraph" },
    paragraph: { content: "inline*" },
    hardBreak: { inline: true, group: "inline" },
    text: { group: "inline" },
  },
  marks: { bold: {}, link: { attrs: { href: {} } } },
});

type Inline = string | { text: string; mark: "bold" | "link" } | "<br>";

function cell(type: "tableHeader" | "tableCell", ...inline: Inline[]) {
  const kids = inline.map((i) => {
    if (i === "<br>") return schema.nodes.hardBreak.create();
    if (typeof i === "string") return schema.text(i);
    const mark =
      i.mark === "bold"
        ? schema.marks.bold.create()
        : schema.marks.link.create({ href: "https://x.test" });
    return schema.text(i.text, [mark]);
  });
  return schema.nodes[type].create(null, schema.nodes.paragraph.create(null, kids));
}

function row(type: "tableHeader" | "tableCell", ...cells: Inline[][]) {
  return schema.nodes.tableRow.create(null, cells.map((c) => cell(type, ...c)));
}

function toMarkdown(table: ProseMirrorNode): string {
  let out = "";
  const state = {
    write: (s: string) => (out += s),
    closeBlock: () => {},
  } as unknown as MarkdownSerializerState;
  serializeTable(state, table);
  return out;
}

describe("serializeTable", () => {
  it("writes a GFM pipe table with the first row as header", () => {
    const t = schema.nodes.table.create(null, [
      row("tableHeader", ["Term"], ["Meaning"]),
      row("tableCell", ["API"], ["Interface"]),
    ]);
    expect(toMarkdown(t)).toBe("| Term | Meaning |\n| --- | --- |\n| API | Interface |\n");
  });

  it("escapes pipes and backslashes so cells can't split or eat the separator", () => {
    const t = schema.nodes.table.create(null, [
      row("tableHeader", ["a|b"], ["c"]),
      row("tableCell", ["x\\y"], ["z"]),
    ]);
    expect(toMarkdown(t)).toBe("| a\\|b | c |\n| --- | --- |\n| x\\\\y | z |\n");
  });

  it("keeps inline marks and writes in-cell line breaks as <br>", () => {
    const t = schema.nodes.table.create(null, [
      row("tableHeader", ["H"]),
      row("tableCell", [{ text: "bold", mark: "bold" }, " ", { text: "l", mark: "link" }, "<br>", "next"]),
    ]);
    expect(toMarkdown(t)).toBe("| H |\n| --- |\n| **bold** [l](https://x.test)<br>next |\n");
  });

  it("pads short rows to the full column count", () => {
    const t = schema.nodes.table.create(null, [
      row("tableHeader", ["A"], ["B"], ["C"]),
      row("tableCell", ["1"]),
    ]);
    expect(toMarkdown(t)).toBe("| A | B | C |\n| --- | --- | --- |\n| 1 |  |  |\n");
  });

  it("matches what the CSV import emits for the same cells (import → save is stable)", () => {
    const rows = [
      ["Term", "Note"],
      ["a|b", "line1\nline2"],
    ];
    const t = schema.nodes.table.create(null, [
      row("tableHeader", ["Term"], ["Note"]),
      row("tableCell", ["a|b"], ["line1", "<br>", "line2"]),
    ]);
    expect(toMarkdown(t).trimEnd()).toBe(rowsToMarkdownTable(rows, { hasHeader: true }));
  });
});
