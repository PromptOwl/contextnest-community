import { describe, it, expect } from "vitest";
import { nestPageForPath, nestPageForView, nestPages, visibleNestPages } from "./nest-pages";

// Built from pages/nest/*/meta.ts — guards what a new page could break.
describe("nest page registry", () => {
  it("finds every page folder in sidebar order", () => {
    expect(nestPages.map((p) => p.id)).toEqual(["board", "graph", "definitions", "workflows"]);
  });

  it("gives every page a unique URL segment and a unique app view", () => {
    const paths = nestPages.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p).toMatch(/^[a-z0-9-]+$/);
    const views = nestPages.map((p) => p.viewPage);
    expect(new Set(views).size).toBe(views.length);
    for (const p of nestPages) {
      expect(nestPageForPath(p.path)?.id).toBe(p.id);
      expect(nestPageForView(p.viewPage)?.id).toBe(p.id);
    }
    expect(nestPageForPath("nope")).toBeUndefined();
    expect(nestPageForPath(null)).toBeUndefined();
  });

  it("gates workflows on the flag and write access; the rest are for everyone", () => {
    const base = { isReadOnly: false, isReaderView: false, canEditDocs: true, workflowPlaneEnabled: true };
    expect(visibleNestPages(base).map((p) => p.id)).toContain("workflows");
    expect(visibleNestPages({ ...base, workflowPlaneEnabled: false }).map((p) => p.id)).not.toContain("workflows");
    expect(visibleNestPages({ ...base, canEditDocs: false }).map((p) => p.id)).toEqual(["board", "graph", "definitions"]);
  });
});
