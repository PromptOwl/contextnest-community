import { describe, it, expect } from "vitest";
import { toggleFacet, streamQueryString, mergeStreamPages, EMPTY_STREAM_FILTERS } from "./doc-stream";

describe("doc stream filters", () => {
  it("toggles a facet value in and out (multi-select)", () => {
    const a = toggleFacet(EMPTY_STREAM_FILTERS, "tag", "fmt");
    expect(a.tag).toEqual(["fmt"]);
    const b = toggleFacet(a, "tag", "gerd");
    expect(b.tag).toEqual(["fmt", "gerd"]);
    expect(toggleFacet(b, "tag", "fmt").tag).toEqual(["gerd"]);
    expect(EMPTY_STREAM_FILTERS.tag).toEqual([]);
  });

  it("builds the query string with repeated params, a pinned nest, and no zero offset", () => {
    const f = toggleFacet(toggleFacet(EMPTY_STREAM_FILTERS, "tag", "fmt"), "tag", "gerd");
    expect(streamQueryString({ ...f, limit: 20, offset: 0 })).toBe("?tag=fmt&tag=gerd&limit=20");
    expect(streamQueryString({ ...EMPTY_STREAM_FILTERS, offset: 40 }, "nest-a")).toBe("?nest=nest-a&offset=40");
    // A pinned nest wins over any nest chips.
    expect(streamQueryString({ ...EMPTY_STREAM_FILTERS, nest: ["x"] }, "nest-a")).toBe("?nest=nest-a");
    expect(streamQueryString({})).toBe("");
  });

  it("appends a page without duplicating items already shown", () => {
    const it = (id: string) => ({ id }) as any;
    expect(mergeStreamPages([it("a"), it("b")], [it("b"), it("c")]).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
