import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  collectWikiLinkDecorations,
  collectWikiLinkRanges,
} from "../ui/src/components/MarkdownEditor/extensions/WikiLink";

// Model-only test — no DOM needed. Builds real ProseMirror docs from the
// editor's schema and asserts the wiki-link decorator's behavior.
const schema = getSchema([StarterKit]);

describe("WikiLink decorations — code-block safety (W3)", () => {
  it("decorates [[Title|Alias]] in a normal paragraph", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("see [[nodes/a|Alpha]] here")]),
    ]);
    // 3 decorations per link: open-bracket-hide, label, close-bracket-hide.
    expect(collectWikiLinkDecorations(doc).length).toBe(3);
  });

  it("does NOT decorate [[ ]] inside a code block", () => {
    const doc = schema.node("doc", null, [
      schema.node("codeBlock", null, [schema.text("const s = '[[nodes/b|Beta]]';")]),
    ]);
    expect(collectWikiLinkDecorations(doc).length).toBe(0);
  });

  it("does NOT decorate [[ ]] within an inline code mark", () => {
    const code = schema.marks.code.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("[[nodes/c|Gamma]]", [code])]),
    ]);
    expect(collectWikiLinkDecorations(doc).length).toBe(0);
  });
});

describe("WikiLink ranges — hidden-bracket boundaries (caret-snap)", () => {
  // "see [[nodes/a|Alpha]] here": paragraph text starts at pos 1.
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("see [[nodes/a|Alpha]] here")]),
  ]);

  it("locates the visible label between the hidden bracket spans", () => {
    const [r] = collectWikiLinkRanges(doc);
    // "[[nodes/a|" hidden on the left, "]]" hidden on the right.
    expect(doc.textBetween(r.start, r.labelStart)).toBe("[[nodes/a|");
    expect(doc.textBetween(r.labelStart, r.labelEnd)).toBe("Alpha");
    expect(doc.textBetween(r.labelEnd, r.end)).toBe("]]");
    expect(r.target).toBe("nodes/a");
    expect(r.displayText).toBe("Alpha");
  });

  it("handles bare [[Title]] with no alias", () => {
    const bare = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("[[Title]]")]),
    ]);
    const [r] = collectWikiLinkRanges(bare);
    expect(bare.textBetween(r.start, r.labelStart)).toBe("[[");
    expect(bare.textBetween(r.labelStart, r.labelEnd)).toBe("Title");
    expect(bare.textBetween(r.labelEnd, r.end)).toBe("]]");
  });
});
