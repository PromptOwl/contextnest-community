import { describe, it, expect, beforeEach, vi } from "vitest";
import * as api from "../ui/src/lib/api";

/**
 * Nest UI read caching — the structural, slow-changing reads hit on every
 * navigation (listNodes, listNests, getNest, getNestSettings) must serve
 * from an in-memory cache instead of re-fetching, and any mutation must
 * invalidate that nest's cache so approval/edit state is never stale.
 */

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as any;

const getListCalls = (spy: any, path: string) =>
  spy.mock.calls.filter(
    (c: any[]) =>
      String(c[0]).endsWith(path) && (!c[1] || c[1].method === undefined),
  );

describe("nest UI read caching @unit", () => {
  let fetchSpy: any;

  beforeEach(() => {
    (api as any).invalidateNestReads?.(); // clear between tests once implemented
    fetchSpy = vi.fn(async () => okJson({ count: 0, nodes: [], node: {} }));
    (globalThis as any).fetch = fetchSpy;
  });

  it("serves a repeated listNodes from cache — one network call", async () => {
    await api.listNodes("nest-1");
    await api.listNodes("nest-1");
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(1);
  });

  it("refetches after a mutation invalidates that nest's cache", async () => {
    await api.listNodes("nest-1"); // fetch #1
    await api.createNode("nest-1", { title: "t", content: "c" }); // invalidate
    await api.listNodes("nest-1"); // fetch #2 (cache cleared)
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(2);
  });

  it("scopes the cache per nest — different nests don't collide", async () => {
    await api.listNodes("nest-1");
    await api.listNodes("nest-2");
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(1);
    expect(getListCalls(fetchSpy, "/nests/nest-2/nodes")).toHaveLength(1);
  });
});
