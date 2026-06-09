import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";

export interface SearchMatch {
  from: number;
  to: number;
}
export interface SearchState {
  query: string;
  caseSensitive: boolean;
  results: SearchMatch[];
  current: number; // index into results; -1 when none
}

/**
 * Pure: find every occurrence of `query` in the document, as absolute
 * positions. Exported so search behavior is unit-testable without a DOM.
 */
export function findRanges(
  doc: ProseMirrorNode,
  query: string,
  caseSensitive: boolean,
): SearchMatch[] {
  const results: SearchMatch[] = [];
  if (!query) return results;
  const needle = caseSensitive ? query : query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const hay = caseSensitive ? node.text : node.text.toLowerCase();
    let i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) {
      results.push({ from: pos + i, to: pos + i + needle.length });
      i += needle.length;
    }
  });
  return results;
}

export const searchKey = new PluginKey<SearchState>("searchReplace");

const EMPTY: SearchState = {
  query: "",
  caseSensitive: false,
  results: [],
  current: -1,
};

export const SearchReplace = Extension.create({
  name: "searchReplace",

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: () => EMPTY,
          apply(tr, value) {
            const meta = tr.getMeta(searchKey) as
              | Partial<SearchState>
              | undefined;
            if (meta) {
              const query = meta.query ?? value.query;
              const caseSensitive = meta.caseSensitive ?? value.caseSensitive;
              const results = findRanges(tr.doc, query, caseSensitive);
              let current = meta.current ?? value.current;
              if (current >= results.length) current = results.length ? 0 : -1;
              if (current < 0 && results.length) current = 0;
              return { query, caseSensitive, results, current };
            }
            if (tr.docChanged && value.query) {
              // Re-resolve matches against the new doc so highlights track edits.
              const results = findRanges(tr.doc, value.query, value.caseSensitive);
              let current = value.current;
              if (current >= results.length) current = results.length ? 0 : -1;
              return { ...value, results, current };
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            const s = searchKey.getState(state);
            if (!s || s.results.length === 0) return DecorationSet.empty;
            const decos = s.results.map((r, idx) =>
              Decoration.inline(r.from, r.to, {
                class:
                  idx === s.current
                    ? "rounded bg-orange-300 dark:bg-orange-600"
                    : "rounded bg-yellow-200 dark:bg-yellow-700/60",
              }),
            );
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

// ── Imperative helpers the search bar calls ───────────────────────────

export function getSearchState(editor: Editor): SearchState {
  return searchKey.getState(editor.state) ?? EMPTY;
}

export function setSearch(
  editor: Editor,
  query: string,
  caseSensitive = false,
): SearchState {
  editor.view.dispatch(
    editor.state.tr.setMeta(searchKey, { query, caseSensitive, current: 0 }),
  );
  const s = getSearchState(editor);
  focusMatch(editor, s.current);
  return s;
}

export function gotoMatch(editor: Editor, dir: 1 | -1): SearchState {
  const s = getSearchState(editor);
  if (s.results.length === 0) return s;
  let current = s.current + dir;
  if (current >= s.results.length) current = 0;
  if (current < 0) current = s.results.length - 1;
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { current }));
  focusMatch(editor, current);
  return getSearchState(editor);
}

function focusMatch(editor: Editor, idx: number) {
  const s = getSearchState(editor);
  const r = s.results[idx];
  if (!r) return;
  // Select the match and scroll it into view. No .focus() — selection still
  // updates while the caret stays in the search input.
  editor.commands.setTextSelection({ from: r.from, to: r.to });
  editor.commands.scrollIntoView();
}

export function replaceCurrent(editor: Editor, replacement: string): SearchState {
  const s = getSearchState(editor);
  const r = s.results[s.current];
  if (!r) return s;
  editor.view.dispatch(editor.state.tr.insertText(replacement, r.from, r.to));
  // docChanged re-resolves results; keep the same index (clamped).
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { current: s.current }));
  return getSearchState(editor);
}

export function replaceAll(editor: Editor, replacement: string): SearchState {
  const s = getSearchState(editor);
  if (s.results.length === 0) return s;
  let tr = editor.state.tr;
  // Replace last→first so earlier positions stay valid.
  for (let i = s.results.length - 1; i >= 0; i--) {
    const r = s.results[i];
    tr = tr.insertText(replacement, r.from, r.to);
  }
  editor.view.dispatch(tr);
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { current: 0 }));
  return getSearchState(editor);
}

export function clearSearch(editor: Editor) {
  editor.view.dispatch(
    editor.state.tr.setMeta(searchKey, { query: "", current: -1 }),
  );
}

export default SearchReplace;
