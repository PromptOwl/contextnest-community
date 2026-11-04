/** CU-wdqcq05rb3 / CU-wdqcq041ku: a view node's server-rendered page, as a standalone page or the editor's preview. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewNodePage } from "./ViewNodePage";

const frameOf = (html: string) => /<iframe[^>]*>/.exec(html)?.[0] ?? "";
const html = renderToStaticMarkup(
  <ViewNodePage nestId="n1" nodeId="nodes/dash" title="Dash" onBack={() => {}} />,
);
const frame = frameOf(html);

describe("ViewNodePage", () => {
  it("frames the hosted view page with the title and a Back button", () => {
    expect(frame).toMatch(/src="[^"]*\/nests\/n1\/nodes\/nodes\/dash\/view\/hosted"/);
    expect(frame).toContain('title="Dash"');
    expect(html).toContain("Back");
  });

  it("does not sandbox the page, so its own data frames get the session cookie", () => {
    expect(frame).not.toContain("sandbox");
  });

  it("passes the version through, so a writer sees their draft", () => {
    const pinned = frameOf(
      renderToStaticMarkup(<ViewNodePage nestId="n1" nodeId="nodes/dash" title="Dash" version={7} />),
    );
    expect(pinned).toMatch(/view\/hosted\?v=7"/);
  });

  it("has no Back row when embedded under the document top bar", () => {
    const embedded = renderToStaticMarkup(<ViewNodePage nestId="n1" nodeId="nodes/dash" title="Dash" />);
    expect(embedded).not.toContain("Back");
  });

  it("is rendered inside DocumentEditor's body, not instead of the editor", () => {
    const src = readFileSync(new URL("./DocumentEditor.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/nodeType === "view"\) \{\s*return <ViewNodePage /);
    expect(src).toContain("<ViewNodePage");
  });
});
