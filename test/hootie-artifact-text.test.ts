/**
 * An HTML artifact reduced to the text a person sees on the page, before it
 * goes to Hootie's model (src/hootie/artifact-text.ts).
 */
import { describe, it, expect } from "vitest";
import { artifactText, isHtmlBody, trimToTokens } from "../src/hootie/artifact-text.js";

describe("artifactText — what the page shows, nothing it runs", () => {
  it("drops script, style, template, noscript and comments, with their content", () => {
    const html = [
      "<!doctype html><html><head><title>Dash</title>",
      "<style>.x { color: red } STYLE</style>",
      '<script type="module">const SCRIPT = "</div>";</script>',
      "<SCRIPT>UPPER</SCRIPT>",
      "</head><body>",
      "<template><p>TEMPLATE</p></template><noscript>NOSCRIPT</noscript>",
      "<!-- COMMENT -->",
      "<h1>Hello</h1><p>World</p>",
      "<script>never closed UNCLOSED",
    ].join("\n");
    const text = artifactText(html);
    for (const gone of ["STYLE", "SCRIPT", "UPPER", "TEMPLATE", "NOSCRIPT", "COMMENT", "UNCLOSED"]) {
      expect(text, gone).not.toContain(gone);
    }
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).not.toMatch(/[<>]/);
  });

  it("treats a <script inside an attribute value as part of its tag", () => {
    expect(artifactText('<div title="<script>x">visible</div><p data-x=\'<style>\'>after</p>')).toBe("visible\nafter");
  });

  it("decodes entities once, and keeps text inside inline tags joined", () => {
    expect(artifactText("<p>Fish &amp; chips &mdash; &lt;b&gt; &#39;x&#x27; &nbsp;&hellip; &amp;lt;</p>")).toBe(
      "Fish & chips — <b> 'x' … &lt;",
    );
    expect(artifactText("<p>Status: <b>Blocked</b> on <a href='x'>legal</a>.</p>")).toBe("Status: Blocked on legal.");
  });

  it("keeps block structure as lines and collapses whitespace", () => {
    const text = artifactText("<h1>Title</h1>\n\n\n<ul>\n  <li>One</li>\n  <li>Two   items</li>\n</ul><div>A</div><div>B</div><table><tr><td>c1</td><td>c2</td></tr></table>");
    expect(text).toBe("Title\nOne\nTwo items\nA\nB\nc1 c2");
  });

  it("tells HTML bodies from markdown", () => {
    expect(isHtmlBody("artifact", "anything")).toBe(true);
    expect(isHtmlBody("document", "  <!DOCTYPE html><html></html>")).toBe(true);
    expect(isHtmlBody("document", "<html lang=en>")).toBe(true);
    expect(isHtmlBody("document", "# Markdown with <b>bold</b>")).toBe(false);
  });
});

describe("trimToTokens — over budget is cut and marked, never dropped", () => {
  it("leaves text that fits alone", () => {
    expect(trimToTokens("short", 100)).toEqual({ text: "short", trimmed: false });
  });
  it("cuts at a word boundary within budget and says so", () => {
    const long = "word ".repeat(1000);
    const { text, trimmed } = trimToTokens(long, 100);
    expect(trimmed).toBe(true);
    expect(text).toMatch(/\[trimmed/);
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text.startsWith("word word")).toBe(true);
  });
});
