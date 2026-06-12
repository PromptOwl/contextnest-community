import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import container from "markdown-it-container";

export type CalloutType = "info" | "tip" | "warn";

const TYPES: CalloutType[] = ["info", "tip", "warn"];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (type?: CalloutType) => ReturnType;
      toggleCallout: (type?: CalloutType) => ReturnType;
    };
  }
}

function normalizeType(raw: string): CalloutType {
  const t = raw.toLowerCase();
  if (t === "tip") return "tip";
  if (t === "warn" || t === "warning") return "warn";
  return "info";
}

/** Register the `::: info|tip|warn` container on a markdown-it instance.
 *  Exported so the round-trip test exercises the exact parse path. */
export function setupCalloutContainer(markdownit: unknown): void {
  (markdownit as { use: (...a: unknown[]) => void }).use(container, "callout", {
    validate: (params: string) =>
      /^(info|tip|warn|warning)\s*$/.test(params.trim()),
    render: (tokens: any[], idx: number) => {
      const token = tokens[idx];
      if (token.nesting === 1) {
        return `<div data-callout="${normalizeType(token.info.trim())}">\n`;
      }
      return "</div>\n";
    },
  });
}

/**
 * Callout / admonition block (info · tip · warn). Persists as a markdown
 * container directive so the file stays HTML-free:
 *
 *   ::: tip
 *   Body markdown here.
 *   :::
 *
 * Parsing is wired through markdown-it-container (in parse.setup), which
 * renders the directive to `<div data-callout="tip">…</div>`; the node's
 * parseHTML then maps that back into the doc.
 */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      type: {
        default: "info" as CalloutType,
        parseHTML: (el) =>
          normalizeType(el.getAttribute("data-callout") || "info"),
        renderHTML: (attrs) => ({ "data-callout": attrs.type }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { class: "cn-callout" }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (type = "info") =>
        ({ commands }) =>
          commands.wrapIn(this.name, { type }),
      toggleCallout:
        (type = "info") =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { type }),
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: ProseMirrorNode) {
          state.write(`::: ${node.attrs.type}\n`);
          state.renderContent(node);
          state.ensureNewLine();
          state.write(":::");
          state.closeBlock(node);
        },
        parse: {
          setup(markdownit: unknown) {
            setupCalloutContainer(markdownit);
          },
        },
      },
    };
  },
});

export { TYPES as CALLOUT_TYPES };
export default Callout;
