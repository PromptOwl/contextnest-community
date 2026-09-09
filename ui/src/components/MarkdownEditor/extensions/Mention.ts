import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface MentionOptions {
  onMentionClick?: (name: string) => void;
  /**
   * Does this `@name` resolve to a real member of the nest? Unresolved
   * mentions style as broken (like `wiki-link-broken`) so a typo can't
   * pass for a live reference. Omit — or return true while the roster is
   * still loading — and every mention styles optimistically as resolved.
   */
  isMember?: (name: string) => boolean;
}

// `@username`, `@user@email.com`, or `@(Name With Spaces)`. The `@` in
// the simple-name char class lets emails (the common case in community
// nests — users invite by email) decorate cleanly. The content stays the
// source of truth; the editor's `@` picker just writes it for you.
const mentionRegex = /(?:^|\s)@(?:\(([^)]+)\)|([a-zA-Z0-9._@-]+))/g;

export const Mention = Extension.create<MentionOptions>({
  name: "mention",

  addOptions() {
    return {
      onMentionClick: undefined,
      isMember: undefined,
    };
  },

  addProseMirrorPlugins() {
    const { onMentionClick, isMember } = this.options;

    return [
      new Plugin({
        key: new PluginKey("mention"),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const doc = state.doc;

            doc.descendants((node, pos, parent) => {
              if (!node.isText || !node.text) return;
              // W3: don't decorate `@name` inside code — it's literal source.
              if (parent?.type.name === "codeBlock") return;
              if (node.marks.some((m) => m.type.name === "code")) return;

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

                const resolved = !isMember || isMember(name);
                const attrs: Record<string, string> = {
                  class: `mention ${resolved ? "mention-user" : "mention-unresolved"}`,
                  "data-mention-name": name,
                };
                if (!resolved) {
                  attrs.title = `No member named "${name}" in this nest`;
                }
                decorations.push(Decoration.inline(start, end, attrs));
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
