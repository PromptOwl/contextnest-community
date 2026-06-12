import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { MarkdownSerializerState } from "prosemirror-markdown";

/**
 * GFM table support. Parsing is free — markdown-it (inside tiptap-markdown)
 * emits `<table>` HTML for `| a | b |` pipe tables, which the table nodes'
 * default parseHTML turns into the doc. Serialization back to markdown is
 * what we add here: prosemirror-markdown has no table serializer.
 *
 * The first row is treated as the header (GFM requires one). Cell inline
 * marks (bold/italic/code/strike/highlight/link) are preserved; block
 * structure and newlines inside a cell are flattened to a single line, as
 * GFM table cells can't hold them.
 */
function cellToMarkdown(cell: ProseMirrorNode): string {
  const parts: string[] = [];
  cell.descendants((n) => {
    if (n.isText && n.text) {
      // Escape backslash first so the pipe-escape's added `\` isn't re-escaped.
      let t = n.text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
      for (const mark of n.marks) {
        switch (mark.type.name) {
          case "bold":
          case "strong":
            t = `**${t}**`;
            break;
          case "italic":
          case "em":
            t = `*${t}*`;
            break;
          case "code":
            t = `\`${t}\``;
            break;
          case "strike":
            t = `~~${t}~~`;
            break;
          case "highlight":
            t = `==${t}==`;
            break;
          case "link":
            t = `[${t}](${mark.attrs.href})`;
            break;
        }
      }
      parts.push(t);
    }
    return true;
  });
  return parts.join("").replace(/\s*\n\s*/g, " ").trim();
}

function serializeTable(state: MarkdownSerializerState, node: ProseMirrorNode) {
  const rows: string[][] = [];
  node.forEach((rowNode) => {
    const cells: string[] = [];
    rowNode.forEach((cellNode) => cells.push(cellToMarkdown(cellNode)));
    rows.push(cells);
  });
  if (rows.length === 0) {
    state.closeBlock(node);
    return;
  }
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => {
    const out = r.slice();
    while (out.length < cols) out.push("");
    return out;
  };
  const header = pad(rows[0]);
  state.write(`| ${header.join(" | ")} |\n`);
  state.write(`| ${header.map(() => "---").join(" | ")} |\n`);
  for (let i = 1; i < rows.length; i++) {
    state.write(`| ${pad(rows[i]).join(" | ")} |\n`);
  }
  state.closeBlock(node);
}

// The table node owns serialization of its whole subtree, so row/cell/header
// only need a no-op serializer to satisfy tiptap-markdown's per-node lookup.
const noop = {
  serialize() {},
  parse: {},
};

export const CnTable = Table.configure({ resizable: true }).extend({
  addStorage() {
    return { markdown: { serialize: serializeTable, parse: {} } };
  },
});

export const CnTableRow = TableRow.extend({
  addStorage() {
    return { markdown: noop };
  },
});

export const CnTableHeader = TableHeader.extend({
  addStorage() {
    return { markdown: noop };
  },
});

export const CnTableCell = TableCell.extend({
  addStorage() {
    return { markdown: noop };
  },
});

export const tableExtensions = [CnTable, CnTableRow, CnTableHeader, CnTableCell];
