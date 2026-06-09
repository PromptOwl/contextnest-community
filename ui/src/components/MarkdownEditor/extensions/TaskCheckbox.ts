import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Match `[ ]`, `[x]`, `[X]` anywhere in a text node. Plain-text in,
// plain-text out — no schema changes needed, which keeps the stored
// markdown round-trippable through Hootie/CLI without losing fidelity.
const taskCheckboxRegex = /\[([ xX])\]/g;

export const TaskCheckbox = Extension.create({
  name: "taskCheckbox",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("taskCheckbox"),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const doc = state.doc;

            doc.descendants((node, pos, parent) => {
              if (!node.isText || !node.text) return;
              // W3: don't decorate `[ ]`/`[x]` inside code — literal source.
              if (parent?.type.name === "codeBlock") return;
              if (node.marks.some((m) => m.type.name === "code")) return;

              const text = node.text;
              let match;
              taskCheckboxRegex.lastIndex = 0;
              while ((match = taskCheckboxRegex.exec(text)) !== null) {
                const isChecked = match[1] === "x" || match[1] === "X";
                const start = pos + match.index;
                const end = start + match[0].length;

                decorations.push(
                  Decoration.inline(start, end, {
                    class: `task-checkbox ${
                      isChecked ? "task-checked" : "task-unchecked"
                    }`,
                    "data-task-checked": isChecked ? "true" : "false",
                  }),
                );
              }
            });

            return DecorationSet.create(doc, decorations);
          },
          handleClick(view, pos, event) {
            const target = event.target as HTMLElement;
            if (!target.classList.contains("task-checkbox")) return false;

            const isChecked =
              target.getAttribute("data-task-checked") === "true";
            const { state } = view;
            const { doc } = state;

            // Re-scan to find the exact text range under the cursor —
            // we can't rely on the decoration's position because the
            // event handler runs after the transaction would be built.
            let found = false;
            doc.descendants((node, nodePos) => {
              if (found || !node.isText || !node.text) return;

              const text = node.text;
              let match;
              taskCheckboxRegex.lastIndex = 0;
              while ((match = taskCheckboxRegex.exec(text)) !== null) {
                const start = nodePos + match.index;
                const end = start + match[0].length;
                if (pos >= start && pos <= end) {
                  const replacement = isChecked ? "[ ]" : "[x]";
                  const tr = state.tr.replaceWith(
                    start,
                    end,
                    state.schema.text(replacement),
                  );
                  view.dispatch(tr);
                  found = true;
                  return false;
                }
              }
            });

            return found;
          },
        },
      }),
    ];
  },
});

export default TaskCheckbox;
