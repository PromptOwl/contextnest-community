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
    vi.restoreAllMocks();
    api.invalidateNestReads(); // clear between tests
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

  it("serves stale instantly after TTL expiry and revalidates in background", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fetchSpy = vi
      .fn()
      .mockImplementationOnce(async () => okJson({ count: 0, nodes: [] }))
      .mockImplementation(async () => okJson({ count: 1, nodes: [{ id: "n" }] }));
    (globalThis as any).fetch = fetchSpy;

    await api.listNodes("nest-1"); // seed the cache
    now += 60_000; // well past the TTL

    const stale = await api.listNodes("nest-1");
    expect(stale.nodes).toHaveLength(0); // old value painted instantly…
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(2); // …revalidation fired

    await new Promise((r) => setTimeout(r, 0)); // let background refresh land
    const fresh = await api.listNodes("nest-1");
    expect(fresh.nodes).toHaveLength(1); // no third network call needed
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(2);
  });

  it("does not re-cache a read that was in flight when a mutation landed", async () => {
    let resolveRead!: (v: unknown) => void;
    fetchSpy = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveRead = r))) // listNodes #1, held open
      .mockImplementation(async () => okJson({ count: 1, nodes: [{ id: "new" }], node: {} }));
    (globalThis as any).fetch = fetchSpy;

    const inFlight = api.listNodes("nest-1"); // read starts…
    await api.createNode("nest-1", { title: "t", content: "c" }); // …mutation invalidates…
    resolveRead(okJson({ count: 0, nodes: [] })); // …then the pre-mutation response lands
    await inFlight;

    const after = await api.listNodes("nest-1"); // must refetch, not serve pre-mutation data
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(2);
    expect(after.nodes).toHaveLength(1);
  });

  it("busts the nests list on a node-level mutation — its rows carry document_count", async () => {
    fetchSpy = vi.fn(async () => okJson({ nests: [], node: {}, count: 0, nodes: [] }));
    (globalThis as any).fetch = fetchSpy;

    await api.listNests();
    await api.createNode("nest-1", { title: "t", content: "c" }); // changes nest-1's document_count
    await api.listNests();
    expect(getListCalls(fetchSpy, "/nests")).toHaveLength(2);
  });

  it("refetches the nests list after syncing an unsynced folder", async () => {
    fetchSpy = vi.fn(async () => okJson({ nests: [], nest: {}, documents: 0 }));
    (globalThis as any).fetch = fetchSpy;

    await api.listNests();
    await api.syncUnsyncedFolder("folder-a"); // POST /nests/unsynced/sync — bypasses the /nests/{id} hook
    await api.listNests();
    expect(getListCalls(fetchSpy, "/nests")).toHaveLength(2);
  });
});
