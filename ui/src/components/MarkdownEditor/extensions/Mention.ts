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

/** One `@name` occurrence as text-relative offsets. `localEnd` is where the
 *  visible chip ends: for an email-shaped mention (`@user@example.com`) it
 *  sits right after the local part, so the decoration builder can hide the
 *  `@domain` remainder — same visible `@user` the read-only viewer's chip
 *  shows, instead of exposing the full address in the editor too. */
export interface MentionMatch {
  start: number;
  end: number;
  localEnd: number;
  name: string;
}

/** Pure text scan, exported so the split between the visible local part and
 *  the hidden domain is unit-testable without a ProseMirror doc. */
export function findMentions(text: string): MentionMatch[] {
  const matches: MentionMatch[] = [];
  mentionRegex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text)) !== null) {
    const fullMatch = match[0];
    const isParenName = match[1] !== undefined;
    const name = (match[1] ?? match[2] ?? "") as string;
    const leadingSpace =
      fullMatch.startsWith(" ") || fullMatch.startsWith("\n") ? 1 : 0;
    const start = match.index + leadingSpace;
    const end = start + fullMatch.length - leadingSpace;
    const atIndex = isParenName ? -1 : name.indexOf("@");
    const localEnd = atIndex > 0 ? start + 1 + atIndex : end;
    matches.push({ start, end, localEnd, name });
  }
  return matches;
}

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
              for (const m of findMentions(text)) {
                const start = pos + m.start;
                const end = pos + m.end;
                const localEnd = pos + m.localEnd;

                const resolved = !isMember || isMember(m.name);
                const attrs: Record<string, string> = {
                  class: `mention ${resolved ? "mention-user" : "mention-unresolved"}`,
                  "data-mention-name": m.name,
                };
                if (!resolved) {
                  attrs.title = `No member named "${m.name}" in this nest`;
                }
                decorations.push(Decoration.inline(start, localEnd, attrs));
                // Email-shaped mention: keep only `@localpart` visible, same
                // as the read-only viewer's chip — the `@domain` remainder
                // stays in the doc (source of truth) but renders hidden.
                if (localEnd < end) {
                  decorations.push(
                    Decoration.inline(localEnd, end, {
                      class: "mention-domain-hidden",
                      "aria-hidden": "true",
                    }),
                  );
                }
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
