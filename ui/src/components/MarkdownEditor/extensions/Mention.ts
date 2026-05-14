import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface MentionOptions {
  onMentionClick?: (name: string) => void;
}

// `@username`, `@user@email.com`, or `@(Name With Spaces)`. The `@` in
// the simple-name char class lets emails (the common case in community
// nests — users invite by email) decorate cleanly. No autocomplete: the
// content is the source of truth, we just style what's there.
const mentionRegex = /(?:^|\s)@(?:\(([^)]+)\)|([a-zA-Z0-9._@-]+))/g;

export const Mention = Extension.create<MentionOptions>({
  name: "mention",

  addOptions() {
    return {
      onMentionClick: undefined,
    };
  },

  addProseMirrorPlugins() {
    const { onMentionClick } = this.options;

    return [
      new Plugin({
        key: new PluginKey("mention"),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const doc = state.doc;

            doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;

              const text = node.text;
              let match;
              mentionRegex.lastIndex = 0;
              while ((match = mentionRegex.exec(text)) !== null) {
                const fullMatch = match[0];
                const name = match[1] || match[2];
                const leadingSpace =
                  fullMatch.startsWith(" ") || fullMatch.startsWith("\n")
                    ? 1
                    : 0;
                const start = pos + match.index + leadingSpace;
                const end = start + fullMatch.length - leadingSpace;

                decorations.push(
                  Decoration.inline(start, end, {
                    class: "mention mention-user",
                    "data-mention-name": name,
                  }),
                );
              }
            });

            return DecorationSet.create(doc, decorations);
          },
          handleClick(_view, _pos, event) {
            const target = event.target as HTMLElement;
            if (!target.classList.contains("mention")) return false;
            const name = target.getAttribute("data-mention-name");
            if (name && onMentionClick) {
              onMentionClick(name);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

export default Mention;
