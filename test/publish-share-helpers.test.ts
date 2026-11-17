/**
 * The pure parts of the share slice (PO-1365, src/nests/publish-share.ts):
 * the excerpt a link preview quotes and the tags it is written into.
 */
import { describe, it, expect } from "vitest";
import { excerptOf, previewMetaTags, signUpUrl, withHeadTags, ctaStrip, PUBLISH_ROBOTS } from "../src/nests/publish-share.js";

describe("excerptOf", () => {
  it("turns markdown into plain text and drops a leading title", () => {
    expect(excerptOf("# Plan\n\nShip **one** thing, [here](https://x.example).", false, "Plan")).toBe(
      "Ship one thing, here.",
    );
  });

  it("only drops a whole leading title", () => {
    expect(excerptOf("Decks are good.", false, "Deck")).toBe("Decks are good.");
    expect(excerptOf("Deck: the plan.", false, "Deck")).toBe("the plan.");
  });

  it("drops script, style and head content from HTML", () => {
    const html =
      "<html><head><title>T</title><style>p{color:red}</style></head><body><script>var secret = 1;</script><p>Visible &amp; safe.</p><!-- hidden --></body></html>";
    expect(excerptOf(html, true)).toBe("Visible & safe.");
  });

  it("drops a tag cut in half, and leaves text after an unclosed script as text", () => {
    expect(excerptOf("<p>Kept</p><div class=", true)).toBe("Kept");
    expect(excerptOf("<p>Kept</p><script>never closed", true)).toBe("Kept never closed");
  });

  it("decodes entities, and never produces half a surrogate pair", () => {
    expect(excerptOf("<p>a&#x26;b &#128512; &lt;i&gt; &unknown;</p>", true)).toBe("a&b 😀 <i> &unknown;");
    const lone = excerptOf("<p>x&#xD800;y&#55357;z&#0;</p>", true);
    expect(lone).toBe("x y z");
  });

  it("returns nothing for a body with no prose", () => {
    expect(excerptOf("<script>1</script>", true)).toBe("");
    expect(excerptOf("", false)).toBe("");
  });

  it("caps at 200 characters on a word boundary", () => {
    const out = excerptOf("alpha ".repeat(100), false);
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith("alpha…")).toBe(true);
  });
});

describe("previewMetaTags", () => {
  const base = { title: "T", url: "https://n.example/p/a", siteName: "S", image: "https://n.example/p/a/og-image", card: "summary" as const };

  it("escapes every value", () => {
    const tags = previewMetaTags({
      ...base,
      title: `"><script>alert(1)</script>`,
      description: `a "b" <c> & d`,
      siteName: `S"><img src=x>`,
      url: `https://n.example/p/a?x="y"&z=<1>`,
    });
    expect(tags).not.toContain("<script>");
    expect(tags).not.toContain("<img");
    expect(tags).toContain(`content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"`);
    expect(tags).toContain(`content="a &quot;b&quot; &lt;c&gt; &amp; d"`);
    // Every tag is still one well-formed element.
    expect(tags.match(/<meta /g)!.length).toBe(tags.match(/">/g)!.length);
  });

  it("leaves the description tags out when there is none", () => {
    const tags = previewMetaTags(base);
    expect(tags).not.toContain("description");
    expect(tags).toContain(`<meta name="robots" content="noindex, nofollow">`);
  });

  it("says noindex, nofollow on every page, open or gated", () => {
    expect(PUBLISH_ROBOTS).toBe("noindex, nofollow");
    const tags = previewMetaTags(base);
    expect(tags.match(/name="robots"/g)).toHaveLength(1);
    expect(tags).not.toMatch(/content="index/);
  });
});

describe("withHeadTags", () => {
  const tags = `<meta property="og:title" content="X">`;
  it("goes right after <head>", () => {
    expect(withHeadTags(`<html><HEAD lang="en"><title>t</title></head></html>`, tags)).toBe(
      `<html><HEAD lang="en">${tags}<title>t</title></head></html>`,
    );
  });
  it("leaves a page with no <head>, or with its own og: tags, alone", () => {
    const bare = "<p>hi</p>";
    expect(withHeadTags(bare, tags)).toBe(bare);
    const own = `<head><meta property='og:image' content="a"></head>`;
    expect(withHeadTags(own, tags)).toBe(own);
  });
});

describe("the strip", () => {
  it("links to the deployment it is given, escaped", () => {
    expect(signUpUrl("https://nest.acme.example")).toBe("https://nest.acme.example/?ref=share");
    const html = ctaStrip(`https://x.example/"><script>`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("Make your own nest");
  });
});
