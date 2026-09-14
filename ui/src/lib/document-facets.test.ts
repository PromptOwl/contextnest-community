/**
 * The bug this pins: Tags/Recently-edited facets must describe whatever
 * document set the caller passes in (the FILTERED list), not the nest-wide
 * set — otherwise applying a status filter leaves the facet bar showing
 * stale data from documents no longer in view.
 */
import { describe, it, expect } from "vitest";
import { documentFacets } from "./document-facets";

const doc = (id: string, over: Record<string, any> = {}) => ({
  id,
  title: id,
  type: "document",
  tags: [] as string[],
  updated_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("documentFacets", () => {
  it("counts each tag once per document, most-used first", () => {
    const nodes = [
      doc("a", { tags: ["#gtm", "#gtm"] }), // duplicate tag on one doc counts once
      doc("b", { tags: ["#gtm"] }),
      doc("c", { tags: ["#eng"] }),
    ];
    expect(documentFacets(nodes).tags).toEqual([
      { tag: "#gtm", count: 2 },
      { tag: "#eng", count: 1 },
    ]);
  });

  it("breaks a count tie alphabetically", () => {
    const nodes = [doc("a", { tags: ["#zeta"] }), doc("b", { tags: ["#alpha"] })];
    expect(documentFacets(nodes).tags).toEqual([
      { tag: "#alpha", count: 1 },
      { tag: "#zeta", count: 1 },
    ]);
  });

  it("returns the newest documents first, capped at the default limit", () => {
    const nodes = [
      doc("a", { updated_at: "2026-01-01T00:00:00.000Z" }),
      doc("b", { updated_at: "2026-01-03T00:00:00.000Z" }),
      doc("c", { updated_at: "2026-01-02T00:00:00.000Z" }),
      doc("d", { updated_at: "2026-01-04T00:00:00.000Z" }),
    ];
    expect(documentFacets(nodes).recent.map((n) => n.id)).toEqual(["d", "b", "c"]);
  });

  it("respects a custom recent limit", () => {
    const nodes = [doc("a"), doc("b"), doc("c")];
    expect(documentFacets(nodes, 1).recent).toHaveLength(1);
  });

  it("omits documents with no updated_at from the recent list", () => {
    const nodes = [doc("a", { updated_at: undefined })];
    expect(documentFacets(nodes).recent).toEqual([]);
  });

  it("is empty when the filtered set is empty — no stale data leaks through", () => {
    expect(documentFacets([])).toEqual({ tags: [], recent: [] });
  });
});
