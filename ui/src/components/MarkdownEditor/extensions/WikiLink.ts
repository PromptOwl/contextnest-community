import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
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

/**
 * One `[[…]]` occurrence as absolute doc positions:
 *   start ──[[── labelStart ──visible label── labelEnd ──]]── end
 * The `[[target|` prefix and trailing `]]` are the hidden (zero-width)
 * spans; the label between them is what the reader sees.
 */
export interface WikiLinkRange {
  start: number;
  labelStart: number;
  labelEnd: number;
  end: number;
  target: string;
  displayText: string;
  hasAlias: boolean;
}

/**
 * Find every `[[…]]` in the doc as absolute-position ranges. Shared by
 * the decoration builder and the caret-snap plugin so both agree on
 * exactly where the hidden brackets sit. Exported for unit tests.
 */
export function collectWikiLinkRanges(doc: ProseMirrorNode): WikiLinkRange[] {
  const ranges: WikiLinkRange[] = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return;
    // W3: never treat code as wiki links — `[[ ]]` inside a code block or an
    // inline `code` mark is literal source, not a link.
    if (parent?.type.name === "codeBlock") return;
    if (node.marks.some((m) => m.type.name === "code")) return;

    const text = node.text;
    let match;
    wikiLinkRegex.lastIndex = 0;
    while ((match = wikiLinkRegex.exec(text)) !== null) {
      const fullMatch = match[0];
      const target = match[1].trim();
      const hasAlias = match[2] !== undefined;
      const displayText = match[2]?.trim() || target;
      const start = pos + match.index;
      const end = start + fullMatch.length;
      // Show alias only; hide `[[target|` + `]]`.
      const labelStart = hasAlias
        ? start + fullMatch.lastIndexOf("|") + 1
        : start + 2;
      const labelEnd = end - 2;
      ranges.push({ start, labelStart, labelEnd, end, target, displayText, hasAlias });
    }
  });
  return ranges;
}

/**
 * Build wiki-link decorations for a whole document, with absolute doc
 * positions. Exported so the behavior is unit-testable against a real
 * ProseMirror doc without a DOM (the model layer needs no browser).
 */
export function collectWikiLinkDecorations(
  doc: ProseMirrorNode,
  checkExists?: WikiLinkOptions["checkExists"],
): Decoration[] {
  const decorations: Decoration[] = [];

  for (const range of collectWikiLinkRanges(doc)) {
    const { start, labelStart, labelEnd, end, target, displayText } = range;
    {
      const cached = existsCache.get(target.toLowerCase());
      const exists = cached?.exists ?? !checkExists;
      const docId = cached?.id;

      const linkClass = exists ? "wiki-link-exists" : "wiki-link-broken";
      const tooltip = exists
        ? `Open "${displayText}"`
        : `"${displayText}" not found in this nest`;

      decorations.push(
        Decoration.inline(start, labelStart, { class: "wiki-bracket-hidden" }),
      );
      decorations.push(
        Decoration.inline(labelStart, labelEnd, {
          class: `wiki-link ${linkClass}`,
          "data-wiki-title": target,
          "data-wiki-id": docId || "",
          "data-wiki-display": displayText,
          title: tooltip,
        }),
      );
      decorations.push(
        Decoration.inline(labelEnd, end, { class: "wiki-bracket-hidden" }),
      );

      if (checkExists && !existsCache.has(target.toLowerCase())) {
        // Seed a tentative entry so we don't fire the same request again
        // while the first one is in flight.
        existsCache.set(target.toLowerCase(), { exists: false });
        checkExists(target)
          .then((result) => {
            existsCache.set(target.toLowerCase(), result);
          })
          .catch(() => {
            /* keep the tentative miss on failure */
          });
      }
    }
  }

  return decorations;
}

/**
 * Snap a collapsed caret out of the hidden `[[ ]]` bracket spans onto the
 * nearest visible label edge. font-size:0 makes those chars zero-width, so
 * a click or arrow can land "inside" a bracket where there's no glyph —
 * the known papercut. We never trap the caret at the link's outer edges
 * (start/end), so the user can still place the cursor before/after a link.
 */
function snapCaretOutOfBrackets(
  ranges: WikiLinkRange[],
  pos: number,
): number | null {
  for (const r of ranges) {
    if (pos > r.start && pos < r.labelStart) return r.labelStart;
    if (pos > r.labelEnd && pos < r.end) return r.labelEnd;
  }
  return null;
}

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
        // Caret-snap: after any selection/doc change, push a collapsed
        // cursor sitting inside a hidden bracket span onto the label edge.
        appendTransaction(transactions, oldState, newState) {
          const sel = newState.selection;
          if (!sel.empty) return null;
          const selChanged = !oldState.selection.eq(sel);
          const docChanged = transactions.some((t) => t.docChanged);
          if (!selChanged && !docChanged) return null;
          const ranges = collectWikiLinkRanges(newState.doc);
          const snapped = snapCaretOutOfBrackets(ranges, sel.from);
          if (snapped === null) return null;
          return newState.tr.setSelection(
            TextSelection.create(newState.doc, snapped),
          );
        },
        props: {
          decorations(state) {
            return DecorationSet.create(
              state.doc,
              collectWikiLinkDecorations(state.doc, checkExists),
            );
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
