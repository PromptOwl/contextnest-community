import { describe, it, expect } from "vitest";
import { crumbLabelClass, documentCrumb, tabTitle } from "./breadcrumb";

describe("documentCrumb", () => {
  const doc = { isNew: false, title: "", loading: false, loadFailed: false };

  it("says Not found for a document that failed to load, even with a stale title", () => {
    expect(documentCrumb({ ...doc, loadFailed: true })).toBe("Not found");
    expect(documentCrumb({ ...doc, title: "Old", loadFailed: true })).toBe("Not found");
  });

  it("names the document, or says what is happening when there is no title", () => {
    expect(documentCrumb({ ...doc, title: " Plan " })).toBe("Plan");
    expect(documentCrumb({ ...doc, loading: true })).toBe("Loading…");
    expect(documentCrumb(doc)).toBe("Untitled");
    expect(documentCrumb({ ...doc, isNew: true })).toBe("New document");
  });
});

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
