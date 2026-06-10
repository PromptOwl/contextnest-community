import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";

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

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "cn-code-copy";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        const text = code.textContent ?? "";
        void navigator.clipboard?.writeText(text);
        copy.textContent = "Copied";
        window.setTimeout(() => {
          copy.textContent = "Copy";
        }, 1200);
      });

      header.append(select, copy);

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
          return true;
        },
      };
    };
  },
}).configure({ lowlight });

export default CodeBlock;
