/** CU-wdqcq05rb3: a view node opens as its server-rendered page, not the editor. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewNodePage } from "./ViewNodePage";

const html = renderToStaticMarkup(
  <ViewNodePage nestId="n1" nodeId="nodes/dash" title="Dash" onBack={() => {}} />,
);
const frame = /<iframe[^>]*>/.exec(html)?.[0] ?? "";

describe("ViewNodePage", () => {
  it("frames the hosted view page with the title and a Back button", () => {
    expect(frame).toMatch(/src="[^"]*\/nests\/n1\/nodes\/nodes\/dash\/view\/hosted"/);
    expect(frame).toContain('title="Dash"');
    expect(html).toContain("Back");
  });

  it("does not sandbox the page, so its own data frames get the session cookie", () => {
    expect(frame).not.toContain("sandbox");
  });

  it("is what DocumentEditor shows for a view node", () => {
    const src = readFileSync(new URL("./DocumentEditor.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/nodeType === "view"\) \{\s*return <ViewNodePage /);
  });
});
