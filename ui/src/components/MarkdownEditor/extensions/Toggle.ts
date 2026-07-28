import {
  Details,
  DetailsSummary,
  DetailsContent,
} from "@tiptap/extension-details";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import { Plugin } from "@tiptap/pm/state";
import container from "markdown-it-container";

const noop = { serialize() {}, parse: {} };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Register the `::: toggle <summary>` container on a markdown-it instance.
 *  Exported so the round-trip test exercises the exact parse path. */
export function setupToggleContainer(markdownit: unknown): void {
  (markdownit as { use: (...a: unknown[]) => void }).use(container, "toggle", {
    validate: (params: string) => /^toggle(\s+.*)?$/.test(params.trim()),
    render: (tokens: any[], idx: number) => {
      const token = tokens[idx];
      if (token.nesting === 1) {
        const summary = token.info.trim().replace(/^toggle\s*/, "");
        return `<details><summary>${
          escapeHtml(summary) || "Toggle"
        }</summary><div data-type="detailsContent">\n`;
      }
      return "</div></details>\n";
    },
  });
}

/**
 * Collapsible toggle block (TipTap Details under the hood). Persists as a
 * markdown container directive — summary on the marker line, body inside:
 *
 *   ::: toggle Click to expand
 *   Hidden body markdown.
 *   :::
 *
 * markdown-it-container (parse.setup) renders it to the
 * `<details><summary>…</summary><div data-type="detailsContent">…</div></details>`
 * shape the Details nodes parse from.
 */
export const Toggle = Details.configure({ persist: true }).extend({
  // The library only wires the chevron button to expand/collapse. Make the
  // whole summary (header) toggle on a single click too; double-click still
  // places the cursor so the header text stays editable.
  addProseMirrorPlugins() {
    const detailsType = this.type;
    return [
      new Plugin({
        props: {
          handleClick(view, pos, event) {
            if ((event as MouseEvent).detail > 1) return false; // dbl-click = edit
            const $pos = view.state.doc.resolve(pos);
            for (let d = $pos.depth; d > 0; d--) {
              if ($pos.node(d).type.name !== "detailsSummary") continue;
              const details = $pos.node(d - 1);
              if (details.type !== detailsType) return false;
              const detailsPos = $pos.before(d - 1);
              view.dispatch(
                view.state.tr.setNodeMarkup(detailsPos, undefined, {
                  ...details.attrs,
                  open: !details.attrs.open,
                }),
              );
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: ProseMirrorNode) {
          let summary = "";
          let body: ProseMirrorNode | null = null;
          node.forEach((child) => {
            if (child.type.name === "detailsSummary") {
              summary = child.textContent.replace(/\s*\n\s*/g, " ").trim();
            } else if (child.type.name === "detailsContent") {
              body = child;
            }
          });
          state.write(`::: toggle ${summary}\n`);
          if (body) state.renderContent(body);
          state.ensureNewLine();
          state.write(":::");
          state.closeBlock(node);
        },
        parse: {
          setup(markdownit: unknown) {
            setupToggleContainer(markdownit);
          },
        },
      },
    };
  },
});

export const ToggleSummary = DetailsSummary.extend({
  addStorage() {
    return { markdown: noop };
  },
});

export const ToggleContent = DetailsContent.extend({
  addStorage() {
    return { markdown: noop };
  },
});

export const toggleExtensions = [Toggle, ToggleSummary, ToggleContent];
