import { textblockTypeInputRule } from "@tiptap/core";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import {
  parseDelimited,
  detectDelimiter,
  detectHeaderRow,
  rowsToMarkdownTable,
  type Delimiter,
} from "@/lib/csv-table";
import { copyTextWithToast } from "@/lib/clipboard";

const lowlight = createLowlight(common);

// Languages offered in the picker. `common` from lowlight registers far
// more; this is just the curated dropdown list (value = lowlight id).
const LANGUAGES: Array<{ id: string; label: string }> = [
  { id: "plaintext", label: "Plain text" },
  { id: "bash", label: "Bash" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "csharp", label: "C#" },
  { id: "css", label: "CSS" },
  // Delimited-data blocks: large CSV/TSV pastes land here instead of a live
  // table (see MarkdownEditor's insertDelimitedTable). Highlighting is a
  // no-op — lowlight has no csv/tsv grammar — but the label tells the user
  // what the block holds and unlocks the "Convert to table" action.
  { id: "csv", label: "CSV" },
  { id: "tsv", label: "TSV" },
  { id: "diff", label: "Diff" },
  { id: "go", label: "Go" },
  { id: "graphql", label: "GraphQL" },
  { id: "html", label: "HTML" },
  { id: "java", label: "Java" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "kotlin", label: "Kotlin" },
  { id: "markdown", label: "Markdown" },
  { id: "php", label: "PHP" },
  { id: "python", label: "Python" },
  { id: "ruby", label: "Ruby" },
  { id: "rust", label: "Rust" },
  { id: "sql", label: "SQL" },
  { id: "swift", label: "Swift" },
  { id: "typescript", label: "TypeScript" },
  { id: "xml", label: "XML" },
  { id: "yaml", label: "YAML" },
];

/**
 * Code block with lowlight syntax highlighting, a language picker, and a
 * copy button. The node name stays `codeBlock`, so tiptap-markdown keeps
 * round-tripping it to ```language fences with no extra serializer.
 *
 * Highlighting is applied by CodeBlockLowlight via decorations on the code
 * text — the custom NodeView only supplies the chrome (header + contentDOM),
 * so the two layers don't conflict.
 */
export const CodeBlock = CodeBlockLowlight.extend({
  addInputRules() {
    // The inherited shortcut (backtickInputRegex) only fires once a
    // trailing space follows the fence, e.g. "```js " — pressing Enter
    // right after "```" doesn't trigger it (Enter is handled by the
    // keymap's block-split, not routed through the input-rule text
    // matcher), so the common "type ``` then start writing code" gesture
    // silently left the backticks as literal text. This rule fires the
    // instant the third backtick is typed on its own, consistent with the
    // other block shortcuts ("- ", "1. ", "# ").
    return [
      ...(this.parent?.() ?? []),
      textblockTypeInputRule({
        find: /^```$/,
        type: this.type,
      }),
    ];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("div");
      dom.className = "cn-code-block";

      const header = document.createElement("div");
      header.className = "cn-code-block-header";
      header.contentEditable = "false";
      // Keep clicks on the header *background* from moving the editor
      // selection — but NOT on the select/button, where preventDefault on
      // mousedown would stop the native dropdown from opening.
      header.addEventListener("mousedown", (e) => {
        if (e.target === header) e.preventDefault();
      });

      const select = document.createElement("select");
      select.className = "cn-code-lang";
      for (const lang of LANGUAGES) {
        const opt = document.createElement("option");
        opt.value = lang.id;
        opt.textContent = lang.label;
        select.append(opt);
      }
      select.value = (node.attrs.language as string) || "plaintext";
      select.addEventListener("change", () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos === undefined) return;
        editor
          .chain()
          .focus(undefined, { scrollIntoView: false })
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              language: select.value,
            });
            return true;
          })
          .run();
      });

      // Always-visible escape hatch for a delimited-data block: convert it to
      // a live markdown table. Mirrors the post-insert toast action, but stays
      // put so a user who missed (or dismissed) the toast can still convert.
      // Shown only when the block is tagged csv/tsv.
      const toTable = document.createElement("button");
      toTable.type = "button";
      toTable.className = "cn-code-copy cn-code-to-table";
      toTable.textContent = "Convert to table";
      toTable.addEventListener("click", () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos === undefined) return;
        const n = editor.state.doc.nodeAt(pos);
        if (!n) return;
        const raw = n.textContent.replace(/\n$/, "");
        const lang = (n.attrs.language as string) || "";
        const delimiter: Delimiter =
          lang === "tsv" ? "\t" : (detectDelimiter(raw) ?? ",");
        const rows = parseDelimited(raw, delimiter);
        if (rows.length === 0) return;
        const md = rowsToMarkdownTable(rows, {
          hasHeader: detectHeaderRow(rows),
        });
        editor
          .chain()
          .focus()
          .deleteRange({ from: pos, to: pos + n.nodeSize })
          .insertContentAt(pos, md)
          .run();
      });

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "cn-code-copy";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        const text = code.textContent ?? "";
        // sonner's toast() works outside React components, so failure
        // feedback matches every other copy button; swap the label only
        // when the copy actually succeeded (insecure contexts can fail).
        void copyTextWithToast(text).then((ok) => {
          if (!ok) return;
          copy.textContent = "Copied";
          window.setTimeout(() => {
            copy.textContent = "Copy";
          }, 1200);
        });
      });

      // Reveal "Convert to table" only for delimited-data blocks.
      const syncActions = (lang: string) => {
        toTable.style.display = lang === "csv" || lang === "tsv" ? "" : "none";
      };
      syncActions(select.value);

      const actions = document.createElement("div");
      actions.className = "cn-code-actions";
      actions.append(toTable, copy);
      header.append(select, actions);

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      pre.append(code);

      dom.append(header, pre);

      return {
        dom,
        contentDOM: code,
        update(updated) {
          if (updated.type !== node.type) return false;
          const lang = (updated.attrs.language as string) || "plaintext";
          if (select.value !== lang) select.value = lang;
          syncActions(lang);
          return true;
        },
      };
    };
  },
}).configure({ lowlight });

export default CodeBlock;
