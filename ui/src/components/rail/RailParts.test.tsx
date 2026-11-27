/**
 * The rail's shared parts (PO-1430): the real rail and the Server settings
 * preview draw from these, so the preview can't drift. Static render.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LayoutGrid } from "lucide-react";
import { RailBrand, RailFooter, RailNestHeading, RailRow, ROW, ROW_ACTIVE, ROW_IDLE } from "./RailParts";

describe("RailParts", () => {
  it("a row carries the rail's row classes, active or idle", () => {
    const active = renderToStaticMarkup(<RailRow icon={LayoutGrid} label="All nests" active />);
    const idle = renderToStaticMarkup(<RailRow icon={LayoutGrid} label="All nests" />);
    for (const c of ROW.split(" ")) expect(active).toContain(c);
    expect(active).toContain(ROW_ACTIVE.split(" ")[0]);
    expect(active).toContain('aria-current="page"');
    expect(idle).toContain(ROW_IDLE.split(" ")[0]);
  });

  it("shows a count pill only when there is a count", () => {
    expect(renderToStaticMarkup(<RailRow icon={LayoutGrid} label="My Work" count={3} tone="primary" />)).toContain("bg-primary");
    expect(renderToStaticMarkup(<RailRow icon={LayoutGrid} label="My Work" />)).not.toContain("rounded-full");
  });

  it("the preview copies carry no test ids, so the real rail's stay unique on the page", () => {
    const real = renderToStaticMarkup(<><RailBrand logoUrl="/o.svg" /><RailFooter>x</RailFooter></>);
    const preview = renderToStaticMarkup(<><RailBrand logoUrl="/o.svg" preview /><RailFooter preview>x</RailFooter></>);
    expect(real).toContain('data-testid="document-sidebar-brand"');
    expect(real).toContain('data-testid="document-sidebar-footer"');
    expect(preview).not.toContain("data-testid");
  });

  it("a nest heading is the uppercase name with its fold chevron", () => {
    const h = renderToStaticMarkup(<RailNestHeading name="Acme" open={false} current={false} />);
    expect(h).toContain("uppercase");
    expect(h).toContain('aria-label="Expand Acme"');
  });
});
