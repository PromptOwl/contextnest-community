import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import container from "markdown-it-container";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    columns: {
      insertColumns: (count?: number) => ReturnType;
    };
  }
}

const noop = { serialize() {}, parse: {} };

/** Register the `:::: columns` / `::: column` containers on a markdown-it
 *  instance. Exported so the round-trip test exercises the nesting path. */
export function setupColumnsContainers(markdownit: unknown): void {
  const md = markdownit as { use: (...a: unknown[]) => void };
  md.use(container, "columns", {
    marker: ":",
    validate: (p: string) => /^columns\s*$/.test(p.trim()),
    render: (tokens: any[], idx: number) =>
      tokens[idx].nesting === 1 ? `<div data-columns>\n` : `</div>\n`,
  });
  md.use(container, "column", {
    marker: ":",
    validate: (p: string) => /^column\s*$/.test(p.trim()),
    render: (tokens: any[], idx: number) =>
      tokens[idx].nesting === 1 ? `<div data-column>\n` : `</div>\n`,
  });
}

/**
 * Side-by-side columns. Persists as nested markdown container directives —
 * the outer block uses four colons so the inner three-colon `column`
 * markers don't prematurely close it (markdown-it-container nests by marker
 * length):
 *
 *   :::: columns
 *   ::: column
 *   Left.
 *   :::
 *   ::: column
 *   Right.
 *   :::
 *   ::::
 */
export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column+",
  defining: true,

  parseHTML() {
    return [{ tag: "div[data-columns]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-columns": "", class: "cn-columns" }),
      0,
    ];
  },

  addCommands() {
    return {
      insertColumns:
        (count = 2) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            content: Array.from({ length: Math.max(2, count) }, () => ({
              type: "column",
              content: [{ type: "paragraph" }],
            })),
          }),
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: ProseMirrorNode) {
          state.write(":::: columns\n");
          node.forEach((col) => {
            state.write("::: column\n");
            state.renderContent(col);
            state.ensureNewLine();
            state.write(":::\n");
          });
          state.write("::::");
          state.closeBlock(node);
        },
        parse: {
          setup(markdownit: unknown) {
            setupColumnsContainers(markdownit);
          },
        },
      },
    };
  },
});

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,

  parseHTML() {
    return [{ tag: "div[data-column]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-column": "", class: "cn-column" }),
      0,
    ];
  },

  addStorage() {
    return { markdown: noop };
  },
});

export const columnExtensions = [Columns, Column];
