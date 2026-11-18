/**
 * The rule that decides when an agent's write is "an HTML page" (PO-1336).
 * Unit level: the MCP and REST behaviour is in mcp-html-artifact.test.ts.
 */
import { describe, it, expect } from "vitest";
import { unwrapHtmlFence, htmlWriteGuard } from "../src/nodes/html-artifact";

const PAGE = "<!DOCTYPE html>\n<html><body><h1>Hi</h1></body></html>";

describe("unwrapHtmlFence", () => {
  it("unwraps a body that is one html fence", () => {
    expect(unwrapHtmlFence("```html\n" + PAGE + "\n```")).toBe(PAGE);
    expect(unwrapHtmlFence("\n\n```HTML\n" + PAGE + "\n```\n\n")).toBe(PAGE);
    expect(unwrapHtmlFence("~~~html\n<div>x</div>\n~~~")).toBe("<div>x</div>");
    expect(unwrapHtmlFence("````html\r\n" + PAGE + "\r\n````")).toBe(PAGE);
  });

  it("unwraps an unlabelled fence only when it holds an HTML document", () => {
    expect(unwrapHtmlFence("```\n" + PAGE + "\n```")).toBe(PAGE);
    expect(unwrapHtmlFence("```\n<div>x</div>\n```")).toBeNull();
    expect(unwrapHtmlFence("```\nplain text\n```")).toBeNull();
  });

  it("leaves everything else alone", () => {
    // another language
    expect(unwrapHtmlFence("```js\nconsole.log(1)\n```")).toBeNull();
    // prose around the block
    expect(unwrapHtmlFence("# Snippet\n\n```html\n<p>x</p>\n```")).toBeNull();
    expect(unwrapHtmlFence("```html\n<p>x</p>\n```\n\nSee above.")).toBeNull();
    // two blocks
    expect(unwrapHtmlFence("```html\n<p>a</p>\n```\n```html\n<p>b</p>\n```")).toBeNull();
    // not closed, or empty
    expect(unwrapHtmlFence("```html\n<p>x</p>")).toBeNull();
    expect(unwrapHtmlFence("```html\n```")).toBeNull();
    expect(unwrapHtmlFence("")).toBeNull();
  });
});

describe("htmlWriteGuard", () => {
  it("turns a default-type fenced page into an artifact without the fence", () => {
    expect(htmlWriteGuard({ content: "```html\n" + PAGE + "\n```" }, true)).toEqual({
      outcome: "stored_as_artifact",
      content: PAGE,
      type: "artifact",
      fenced: true,
    });
    expect(
      htmlWriteGuard({ type: "document", content: "```html\n" + PAGE + "\n```" }, true)?.type,
    ).toBe("artifact");
  });

  it("turns a bare HTML document into an artifact as sent", () => {
    expect(htmlWriteGuard({ content: PAGE }, true)).toEqual({
      outcome: "stored_as_artifact",
      content: PAGE,
      type: "artifact",
      fenced: false,
    });
  });

  it("keeps the write as sent when artifacts are disabled, and says so", () => {
    const fenced = "```html\n" + PAGE + "\n```";
    expect(htmlWriteGuard({ content: fenced }, false)).toEqual({
      outcome: "artifacts_disabled",
      content: fenced,
      fenced: true,
    });
  });

  it("removes the fence on an artifact, even when artifacts are disabled for new nodes", () => {
    const fenced = "```html\n" + PAGE + "\n```";
    for (const enabled of [true, false]) {
      expect(htmlWriteGuard({ type: "artifact", content: fenced }, enabled)).toEqual({
        outcome: "fence_removed",
        content: PAGE,
        fenced: true,
      });
      expect(htmlWriteGuard({ storedType: "artifact", content: fenced }, enabled)?.outcome).toBe(
        "fence_removed",
      );
    }
    expect(htmlWriteGuard({ type: "artifact", content: PAGE }, true)).toBeNull();
  });

  it("uses the stored type on an update, and an explicit type over it", () => {
    expect(htmlWriteGuard({ storedType: "document", content: PAGE }, true)?.type).toBe("artifact");
    expect(htmlWriteGuard({ storedType: "glossary", content: PAGE }, true)).toBeNull();
    expect(htmlWriteGuard({ storedType: "artifact", type: "document", content: PAGE }, true)?.type).toBe(
      "artifact",
    );
  });

  it("does not touch mixed markdown, other types, or a write with no body", () => {
    expect(
      htmlWriteGuard({ content: "# How to\n\nUse this:\n\n```html\n<p>x</p>\n```\n" }, true),
    ).toBeNull();
    expect(htmlWriteGuard({ type: "task", content: PAGE }, true)).toBeNull();
    expect(htmlWriteGuard({ type: "skill", content: "```html\n" + PAGE + "\n```" }, true)).toBeNull();
    expect(htmlWriteGuard({ content: undefined }, true)).toBeNull();
    expect(htmlWriteGuard({ content: "plain words" }, true)).toBeNull();
  });
});
