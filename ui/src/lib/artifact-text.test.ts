import { describe, it, expect } from "vitest";
import { isHtmlBody } from "./artifact-text";

describe("isHtmlBody", () => {
  it("treats a page that starts with a tag as HTML", () => {
    expect(isHtmlBody("<!doctype html><html></html>")).toBe(true);
  });

  // A pushed body keeps the blank line under the frontmatter's closing `---`.
  it("treats a page after leading blank lines as HTML", () => {
    expect(isHtmlBody("\n\n<!doctype html>\n<html></html>")).toBe(true);
    expect(isHtmlBody("  \t<div>hi</div>")).toBe(true);
  });

  it("treats markdown and plain text as not HTML", () => {
    expect(isHtmlBody("# Title\n\n<b>inline</b>")).toBe(false);
    expect(isHtmlBody("so <b>")).toBe(false);
    expect(isHtmlBody("")).toBe(false);
  });
});
