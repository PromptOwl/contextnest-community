import { describe, it, expect, beforeEach, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import * as api from "../ui/src/lib/api";
import {
  createQueryClient,
  connectReadCache,
  nestQueries,
} from "../ui/src/lib/queries";

/**
 * Nest UI read caching — the structural reads hit on every navigation
 * (listNodes, listNests, getNest, getNestSettings) must serve from the shared
 * client cache instead of re-fetching, and any mutation must invalidate that
 * nest's entries so approval/edit state is never stale.
 *
 * These exercise the query layer through the same `connectReadCache` bridge the
 * app shell wires up, so the api-module invalidation hooks are under test too.
 */

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as any;

const errJson = (status: number, body: unknown = { error: "nope" }) =>
  ({ ok: false, status, text: async () => JSON.stringify(body) }) as any;

const getListCalls = (spy: any, path: string) =>
  spy.mock.calls.filter(
    (c: any[]) =>
      String(c[0]).endsWith(path) && (!c[1] || c[1].method === undefined),
  );

describe("nest UI read caching @unit", () => {
  let fetchSpy: any;
  let qc: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    qc = createQueryClient();
    connectReadCache(qc);
    fetchSpy = vi.fn(async () => okJson({ count: 0, nodes: [], node: {} }));
    (globalThis as any).fetch = fetchSpy;
  });

  it("serves a repeated listNodes from cache — one network call", async () => {
    await qc.fetchQuery(nestQueries.nodes("nest-1"));
    await qc.fetchQuery(nestQueries.nodes("nest-1"));
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(1);
  });

  it("refetches after a mutation invalidates that nest's cache", async () => {
    await qc.fetchQuery(nestQueries.nodes("nest-1")); // fetch #1
    await api.createNode("nest-1", { title: "t", content: "c" }); // invalidate
    await qc.fetchQuery(nestQueries.nodes("nest-1")); // fetch #2
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(2);
  });

  it("scopes the cache per nest — different nests don't collide", async () => {
    await qc.fetchQuery(nestQueries.nodes("nest-1"));
    await qc.fetchQuery(nestQueries.nodes("nest-2"));
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(1);
    expect(getListCalls(fetchSpy, "/nests/nest-2/nodes")).toHaveLength(1);
  });

  it("invalidating one nest leaves a sibling whose id shares its prefix alone", async () => {
    await qc.fetchQuery(nestQueries.nodes("nest-1"));
    await qc.fetchQuery(nestQueries.nodes("nest-12"));
    await api.createNode("nest-1", { title: "t", content: "c" });

    await qc.fetchQuery(nestQueries.nodes("nest-1")); // stale → refetch
    await qc.fetchQuery(nestQueries.nodes("nest-12")); // untouched → cached
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(2);
    expect(getListCalls(fetchSpy, "/nests/nest-12/nodes")).toHaveLength(1);
  });

  it("deduplicates two simultaneous reads of the same data into one request", async () => {
    const [a, b] = await Promise.all([
      qc.fetchQuery(nestQueries.nodes("nest-1")),
      qc.fetchQuery(nestQueries.nodes("nest-1")),
    ]);
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("busts the nests list on a node-level mutation — its rows carry document_count", async () => {
    fetchSpy = vi.fn(async () => okJson({ nests: [], node: {}, count: 0, nodes: [] }));
    (globalThis as any).fetch = fetchSpy;

    await qc.fetchQuery(nestQueries.list());
    await api.createNode("nest-1", { title: "t", content: "c" });
    await qc.fetchQuery(nestQueries.list());
    expect(getListCalls(fetchSpy, "/nests")).toHaveLength(2);
  });

  it("refetches the nests list after syncing an unsynced folder", async () => {
    fetchSpy = vi.fn(async () => okJson({ nests: [], nest: {}, documents: 0 }));
    (globalThis as any).fetch = fetchSpy;

    await qc.fetchQuery(nestQueries.list());
    await api.syncUnsyncedFolder("folder-a"); // bypasses the /nests/{id} hook
    await qc.fetchQuery(nestQueries.list());
    expect(getListCalls(fetchSpy, "/nests")).toHaveLength(2);
  });

  it("drops every entry on an identity change — no cross-user leakage", async () => {
    await qc.fetchQuery(nestQueries.nodes("nest-1"));
    await qc.fetchQuery(nestQueries.list());

    api.invalidateNestReads(); // what login / logout / user switch calls

    expect(qc.getQueryData(nestQueries.nodes("nest-1").queryKey)).toBeUndefined();
    expect(qc.getQueryData(nestQueries.list().queryKey)).toBeUndefined();
  });

  it("does not cache a failed read as if it were data", async () => {
    fetchSpy = vi.fn(async () => errJson(500));
    (globalThis as any).fetch = fetchSpy;

    await expect(qc.fetchQuery(nestQueries.nodes("nest-1"))).rejects.toThrow();
    expect(qc.getQueryData(nestQueries.nodes("nest-1").queryKey)).toBeUndefined();
  });

  it("does not retry a 403 — it is an answer, not a blip", async () => {
    fetchSpy = vi.fn(async () => errJson(403));
    (globalThis as any).fetch = fetchSpy;

    await expect(qc.fetchQuery(nestQueries.nodes("nest-1"))).rejects.toThrow();
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(1);
  });
});
