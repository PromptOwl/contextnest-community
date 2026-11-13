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

// ── po-1214: the stream as a feed ────────────────────────────────────────────
import { postAction, postIdentity, initialsOf, newPostCount, compactTime, activeFilterCount } from "./doc-stream";

const item = (over: Record<string, unknown> = {}) =>
  ({
    id: "n:a@1", nestId: "n", nestName: "Revenue", nodeId: "a", title: "T", type: "document", tags: [],
    version: 1, status: "published", author: "dana@acme.com", authorName: "Dana Okafor", client: null,
    changeNote: null, review: null, at: "2026-11-01 09:00:00", summary: "", commentCount: 0, kind: "created",
    ...over,
  }) as any;

describe("doc stream feed posts (po-1214)", () => {
  it("AC-ST-02: Given an agent version, Then the identity is the person's display name plus the agent", () => {
    expect(postIdentity(item({ client: { agent: "mkt-amplifier" } }))).toEqual({ name: "Dana Okafor", agent: "mkt-amplifier" });
    expect(postIdentity(item({ authorName: null }))).toEqual({ name: "dana", agent: null });
    // A public reader's post has no author at all.
    expect(postIdentity(item({ author: null, authorName: null }))).toEqual({ name: "Someone", agent: null });
  });

  it("AC-ST-03: Given each kind of version, Then the post says what happened in words", () => {
    expect(postAction(item({ kind: "created" }))).toBe("created");
    expect(postAction(item({ kind: "updated", version: 2, status: "draft" }))).toBe("edited");
    expect(postAction(item({ kind: "updated", version: 2, status: "pending_review" }))).toBe("submitted for review");
    expect(postAction(item({ kind: "created", status: "pending_review" }))).toBe("submitted for review");
    expect(postAction(item({ kind: "published", version: 3 }))).toBe("published");
    expect(postAction(item({ kind: "approved" }))).toBe("got approval on");
    expect(postAction(item({ kind: "rejected" }))).toBe("got changes requested on");
  });

  it("AC-ST-02: Given a name, Then the avatar shows up to two initials", () => {
    expect(initialsOf("Dana Okafor")).toBe("DO");
    expect(initialsOf("dana")).toBe("D");
    expect(initialsOf("")).toBe("?");
  });

  it("AC-ST-06: Given a poll since the newest post, Then the pill counts only posts not already shown", () => {
    const shown = [item({ id: "x", at: "2026-11-01 09:05:00" }), item({ id: "y", at: "2026-11-01 09:04:00" })];
    // The poll's `since` is the newest post's time: that post is in `total` too.
    expect(newPostCount(shown, "2026-11-01 09:05:00", 4)).toBe(3);
    expect(newPostCount(shown, "2026-11-01 09:05:00", 1)).toBe(0);
    expect(newPostCount([], undefined, 5)).toBe(0);
  });

  it("AC-ST-02: Given a timestamp, Then the time is compact (5m, 3h, 2d, then a date)", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(compactTime("2026-11-10 11:55:00", now)).toBe("5m");
    expect(compactTime("2026-11-10 09:00:00", now)).toBe("3h");
    expect(compactTime("2026-11-08 12:00:00", now)).toBe("2d");
    expect(compactTime("2026-10-01 12:00:00", now)).toBe("Oct 1");
    expect(compactTime("2026-11-10 11:59:50", now)).toBe("now");
  });

  it("AC-ST-04: Given filters and a source toggle, Then the query carries source and the poll skips facets", () => {
    expect(streamQueryString({ source: "agent", limit: 1, facets: false, since: "2026-11-01 09:00:00" })).toBe(
      "?since=2026-11-01+09%3A00%3A00&limit=1&source=agent&facets=0",
    );
    const f = toggleFacet(toggleFacet(EMPTY_STREAM_FILTERS, "tag", "fmt"), "nest", "n1");
    expect(activeFilterCount(f)).toBe(2);
    expect(activeFilterCount(EMPTY_STREAM_FILTERS)).toBe(0);
  });
});
