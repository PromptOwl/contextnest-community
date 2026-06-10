import { describe, it, expect } from "vitest";
import MarkdownIt from "markdown-it";
import { setupCalloutContainer } from "../ui/src/components/MarkdownEditor/extensions/Callout";
import { setupToggleContainer } from "../ui/src/components/MarkdownEditor/extensions/Toggle";
import { setupColumnsContainers } from "../ui/src/components/MarkdownEditor/extensions/Columns";

// Exercises the parse half of the custom blocks' markdown round-trip: the
// `:::` container directives the nodes persist as must render to the exact
// HTML shape the node parseHTML() rules consume. No HTML lives in the
// stored markdown — these tests assert the directives ARE the source form.
const md = new MarkdownIt({ html: true });
setupCalloutContainer(md);
setupToggleContainer(md);
setupColumnsContainers(md);

describe("Custom block markdown — container directives parse to node HTML", () => {
  it("callout `::: tip` → div[data-callout=tip] with inner markdown", () => {
    const html = md.render(":::tip\nHeads **up**\n:::");
    expect(html).toContain('data-callout="tip"');
    expect(html).toContain("<strong>up</strong>");
  });

  it("callout normalizes `warning` → warn", () => {
    expect(md.render(":::warning\nx\n:::")).toContain('data-callout="warn"');
  });

  it("toggle `::: toggle Summary` → details/summary/content", () => {
    const html = md.render("::: toggle Click me\nHidden body\n:::");
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Click me</summary>");
    expect(html).toContain('data-type="detailsContent"');
    expect(html).toContain("Hidden body");
  });

  it("columns nest: `::::` outer holds `:::` column children", () => {
    const src =
      ":::: columns\n::: column\nLeft\n:::\n::: column\nRight\n:::\n::::";
    const html = md.render(src);
    expect(html).toContain("data-columns");
    // Two distinct columns, not one swallowed by the outer marker.
    expect((html.match(/data-column[^s]/g) || []).length).toBe(2);
    expect(html).toContain("Left");
    expect(html).toContain("Right");
  });

  it("a bare `:::` paragraph is not mistaken for a callout", () => {
    const html = md.render("just some text\n\nmore text");
    expect(html).not.toContain("data-callout");
  });
});
