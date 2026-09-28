/**
 * Tag names this app's markdown pipelines give special meaning to when raw
 * HTML shows up in stored markdown — `span` for the editor's color-mark
 * round-trip (see MarkdownEditor.tsx's TextStyle/Color comment) plus the
 * handful of tags a hand-authored legacy doc might reasonably contain.
 *
 * Both markdown-it (Rich editor) and remark (read-only Preview) treat ANY
 * `<word>` as a raw HTML tag per CommonMark, not just real HTML — so
 * generic-type prose like "Array<string>" or a "<TODO>" placeholder matches
 * the same grammar. An unrecognized tag has nowhere to go: the editor's
 * ProseMirror parser drops it — and, since there's no separate "string" text
 * outside the tag, its content along with it — while the Preview renderer's
 * HTML stripping erases it outright. Treating only *this* list as real
 * markup, and everything else as literal text, fixes both without touching
 * the html:true / raw-HTML support those pipelines still need for real
 * markup.
 */
export const KNOWN_HTML_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "div", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "mark",
  "ol", "p", "pre", "s", "span", "strong", "sub", "sup",
  "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
]);

const HTML_TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?\/?)>/g;

function isKnownHtmlTag(name: string): boolean {
  return KNOWN_HTML_TAGS.has(name.toLowerCase());
}

// Skip fenced code blocks and inline code spans — raw HTML is never
// interpreted inside them, so their content is already round-trip-safe and
// must be left byte-for-byte alone.
const CODE_OR_TAG_RE = new RegExp(
  "(```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`\\n]*`)|" + HTML_TAG_RE.source,
  "g",
);

/**
 * Escapes the `<` of any tag-like run in markdown SOURCE whose name isn't a
 * real tag we round-trip, so markdown-it reads it as plain text instead of
 * an (unmapped, content-dropping) HTML tag. Call this right before handing
 * markdown to the Rich editor's parser.
 */
export function escapeUnknownInlineHtml(markdown: string): string {
  return markdown.replace(
    CODE_OR_TAG_RE,
    (
      match: string,
      code: string | undefined,
      slash: string,
      name: string,
      rest: string,
    ) => {
      if (code !== undefined) return code;
      if (isKnownHtmlTag(name)) return match;
      return `&lt;${slash}${name}${rest}>`;
    },
  );
}

/**
 * Strips only recognized-tag runs from an already-tokenized raw-HTML string
 * (a react-markdown/remark `html` node's value), leaving anything else —
 * including tag-shaped prose like "<string>" — as literal text. Loops until
 * stable so removing a known tag can't reassemble leftover fragments into
 * another one.
 */
export function stripKnownHtmlTags(value: string): string {
  let result = value;
  let prev: string;
  do {
    prev = result;
    result = result.replace(
      HTML_TAG_RE,
      (match: string, _slash: string, name: string) =>
        isKnownHtmlTag(name) ? "" : match,
    );
  } while (result !== prev);
  return result;
}
