import { describe, expect, it } from "vitest";
import { escapeUnknownInlineHtml, stripKnownHtmlTags } from "./html-tag-allowlist";

describe("escapeUnknownInlineHtml", () => {
  it("escapes a generic-type angle-bracket run so it survives as literal text", () => {
    expect(escapeUnknownInlineHtml("Intro with generic Array<string> type.")).toBe(
      "Intro with generic Array&lt;string> type.",
    );
  });

  it("leaves a real tag this app round-trips (the color-mark span) untouched", () => {
    const md = 'x <span style="color: #ff0000">y</span> z';
    expect(escapeUnknownInlineHtml(md)).toBe(md);
  });

  it("does not touch tag-like text inside an inline code span", () => {
    const md = "use `Array<string>` here";
    expect(escapeUnknownInlineHtml(md)).toBe(md);
  });

  it("does not touch tag-like text inside a fenced code block", () => {
    const md = "```\nArray<string>\n```";
    expect(escapeUnknownInlineHtml(md)).toBe(md);
  });

  it("escapes an unknown closing tag too", () => {
    expect(escapeUnknownInlineHtml("</Foo>")).toBe("&lt;/Foo>");
  });
});

describe("stripKnownHtmlTags", () => {
  it("strips a real tag this app treats as markup", () => {
    expect(stripKnownHtmlTags('<span style="color: #ff0000">')).toBe("");
    expect(stripKnownHtmlTags("</span>")).toBe("");
  });

  it("leaves tag-shaped prose that isn't real markup as literal text", () => {
    expect(stripKnownHtmlTags("<string>")).toBe("<string>");
  });
});
