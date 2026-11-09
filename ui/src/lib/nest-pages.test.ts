import { describe, it, expect } from "vitest";
import { nestPageForPath, nestPageForView, nestPages, visibleNestPages } from "./nest-pages";

// Built from pages/nest/*/meta.ts — guards what a new page could break.
describe("nest page registry", () => {
  it("finds every page folder in sidebar order", () => {
    expect(nestPages.map((p) => p.id)).toEqual(["board", "graph", "definitions", "workflows", "structure", "channels"]);
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

  it("gates workflows on the flag and write access; the rest are for everyone but a reader", () => {
    const base = { isReadOnly: false, isReaderView: false, canEditDocs: true, workflowPlaneEnabled: true };
    expect(visibleNestPages(base).map((p) => p.id)).toContain("workflows");
    expect(visibleNestPages({ ...base, workflowPlaneEnabled: false }).map((p) => p.id)).not.toContain("workflows");
    expect(visibleNestPages({ ...base, canEditDocs: false }).map((p) => p.id)).toEqual(["board", "graph", "definitions", "structure"]);
    // Every nest has its own rules; a docs-site reader is not shown them.
    expect(visibleNestPages({ ...base, isReaderView: true }).map((p) => p.id)).not.toContain("structure");
  });

  it("AC-CH-01 lists Channels only while the server's agent-stream switch is on, for readers too", () => {
    const base = { isReadOnly: false, isReaderView: false, canEditDocs: true, workflowPlaneEnabled: true };
    expect(visibleNestPages(base).map((p) => p.id)).not.toContain("channels");
    expect(visibleNestPages({ ...base, agentStreamEnabled: false }).map((p) => p.id)).not.toContain("channels");
    expect(visibleNestPages({ ...base, agentStreamEnabled: true, isMember: true }).map((p) => p.id)).toContain("channels");
    expect(
      visibleNestPages({ ...base, agentStreamEnabled: true, isMember: true, isReadOnly: true, canEditDocs: false }).map((p) => p.id),
    ).toContain("channels");
  });

  it("AC-UX-15 lists Channels only for a person added to the nest, never for a share-only or public reader", () => {
    const base = { isReadOnly: true, isReaderView: false, canEditDocs: false, workflowPlaneEnabled: true, agentStreamEnabled: true };
    expect(visibleNestPages({ ...base, isMember: true }).map((p) => p.id)).toContain("channels");
    expect(visibleNestPages({ ...base, isMember: false }).map((p) => p.id)).not.toContain("channels");
    // Not known yet (the nest read is still loading): stay hidden rather than flash.
    expect(visibleNestPages(base).map((p) => p.id)).not.toContain("channels");
    expect(visibleNestPages({ ...base, isMember: true, agentStreamEnabled: false }).map((p) => p.id)).not.toContain("channels");
  });
});
