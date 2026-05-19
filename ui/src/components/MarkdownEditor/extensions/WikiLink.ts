import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface WikiLinkOptions {
  onWikiLinkClick?: (title: string, id: string | null) => void;
  /**
   * Resolve a title to a document id so the decoration can advertise
   * whether the link is broken (purple/italic) or live (blue/solid).
   * Caller wires this to `api.searchNodes(nestId, title)` and picks the
   * exact-title match. Optional — without it every link styles as
   * "exists" (the parent's click handler still gets to decide whether
   * navigation succeeds).
   */
  checkExists?: (title: string) => Promise<{ exists: boolean; id?: string }>;
}

// `[[Title]]` or `[[Title|Display text]]`. Greedy until ]] to allow
// titles with spaces; the | alias form mirrors common wiki conventions.
const wikiLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// Process-wide cache so re-renders don't re-fire the existence check
// for every keystroke. Keyed on lowercased title (case-insensitive
// matches feel less brittle to users).
const existsCache = new Map<string, { exists: boolean; id?: string }>();

export const WikiLink = Extension.create<WikiLinkOptions>({
  name: "wikiLink",

  addOptions() {
    return {
      onWikiLinkClick: undefined,
      checkExists: undefined,
    };
  },

  addProseMirrorPlugins() {
    const { onWikiLinkClick, checkExists } = this.options;

    return [
      new Plugin({
        key: new PluginKey("wikiLink"),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const doc = state.doc;

            doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;

              const text = node.text;
              let match;
              wikiLinkRegex.lastIndex = 0;
              while ((match = wikiLinkRegex.exec(text)) !== null) {
                const fullMatch = match[0];
                const title = match[1].trim();
                const displayText = match[2]?.trim() || title;
                const start = pos + match.index;

                const cached = existsCache.get(title.toLowerCase());
                const exists = cached?.exists ?? !checkExists;
                const docId = cached?.id;

                const linkClass = exists
                  ? "wiki-link-exists"
                  : "wiki-link-broken";
                const tooltip = exists
                  ? `Open "${title}"`
                  : `"${title}" not found in this nest`;

                const openBracketEnd = start + 2;
                const closeBracketStart = start + fullMatch.length - 2;

                decorations.push(
                  Decoration.inline(start, openBracketEnd, {
                    class: "wiki-bracket-hidden",
                  }),
                );
                decorations.push(
                  Decoration.inline(openBracketEnd, closeBracketStart, {
                    class: `wiki-link ${linkClass}`,
                    "data-wiki-title": title,
                    "data-wiki-id": docId || "",
                    "data-wiki-display": displayText,
                    title: tooltip,
                  }),
                );
                decorations.push(
                  Decoration.inline(
                    closeBracketStart,
                    start + fullMatch.length,
                    { class: "wiki-bracket-hidden" },
                  ),
                );

                if (checkExists && !existsCache.has(title.toLowerCase())) {
                  // Seed a tentative entry so we don't fire the same
                  // request again while the first one is in flight.
                  existsCache.set(title.toLowerCase(), { exists: false });
                  checkExists(title)
                    .then((result) => {
                      existsCache.set(title.toLowerCase(), result);
                    })
                    .catch(() => {
                      /* keep the tentative miss on failure */
                    });
                }
              }
            });

            return DecorationSet.create(doc, decorations);
          },
          handleClick(_view, _pos, event) {
            const target = event.target as HTMLElement;
            if (!target.classList.contains("wiki-link")) return false;
            const title = target.getAttribute("data-wiki-title");
            const id = target.getAttribute("data-wiki-id") || null;
            if (title && onWikiLinkClick) {
              onWikiLinkClick(title, id);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

export default WikiLink;
