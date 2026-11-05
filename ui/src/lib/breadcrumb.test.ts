import { describe, it, expect } from "vitest";
import { crumbLabelClass, tabTitle } from "./breadcrumb";

describe("crumbLabelClass", () => {
  it("lets the current crumb truncate instead of overflowing an unbreakable name", () => {
    const cls = crumbLabelClass(true);
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("truncate");
    expect(cls).toContain("font-semibold");
  });

  it("lets an ancestor crumb truncate the same way", () => {
    const cls = crumbLabelClass(false);
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("truncate");
    expect(cls).toContain("text-muted-foreground");
  });
});

describe("tabTitle", () => {
  it("puts the page first, then the nest, then the product", () => {
    expect(tabTitle([{ label: "Home" }, { label: "QA Nest" }, { label: "Board" }])).toBe("Board – QA Nest – ContextNest");
    expect(tabTitle([{ label: "Home" }, { label: "Teammates" }])).toBe("Teammates – ContextNest");
  });

  it("falls back to the product name with no crumbs", () => {
    expect(tabTitle([])).toBe("ContextNest");
    expect(tabTitle([{ label: "" }])).toBe("ContextNest");
  });
});
