/** Support rich-text formatting in comments. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { applyFormat, mentionsToLinks } from "./comment-format";
import { CommentBody } from "../components/MentionTextarea";

describe("applyFormat", () => {
  it("bold wraps the selection, or drops a ** pair at the caret", () => {
    expect(applyFormat("make this bold", 5, 9, "bold")).toEqual({ value: "make **this** bold", start: 7, end: 11 });
    expect(applyFormat("ab", 1, 1, "bold")).toEqual({ value: "a****b", start: 3, end: 3 });
  });

  it("line formats prefix every line the selection touches", () => {
    const v = "intro\none\ntwo\noutro";
    expect(applyFormat(v, 7, 11, "bullet").value).toBe("intro\n- one\n- two\noutro");
    expect(applyFormat(v, 7, 11, "numbered").value).toBe("intro\n1. one\n2. two\noutro");
    expect(applyFormat("Title", 2, 2, "heading")).toEqual({ value: "### Title", start: 0, end: 9 });
  });
});

describe("mentionsToLinks", () => {
  it("turns mentions into indexed links, escaping brackets", () => {
    expect(
      mentionsToLinks([
        { kind: "text", text: "hi " },
        { kind: "mention", text: "@[Ada]", name: "Ada", resolved: true },
      ]),
    ).toBe("hi [@\\[Ada\\]](#mention-1)");
  });
});

describe("CommentBody", () => {
  const html = (body: string) => renderToStaticMarkup(<CommentBody body={body} members={[]} />);

  it("renders markdown: bold, headings, lists", () => {
    const h = html("### Steps\n\n1. **Open** the board\n2. Drag a card");
    expect(h).toContain("<h3>Steps</h3>");
    expect(h).toContain("<ol>");
    expect(h).toContain("<strong>Open</strong>");
  });

  it("keeps a plain comment's line breaks and still styles mentions", () => {
    const h = html("line one\nline two @ada@acme.dev");
    expect(h).toContain("line one\nline two");
    expect(h).toContain("whitespace-pre-wrap");
    expect(h).toContain("bg-primary/10");
  });
});
